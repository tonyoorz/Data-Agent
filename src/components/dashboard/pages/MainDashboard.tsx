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
  selectTicketRowsForDrilldown,
} from "@/components/dashboard/main-dashboard/mainDashboardFiltering";
import { getLatestTicketDateLabel } from "@/components/dashboard/main-dashboard/mainDashboardDateUtils";
import type { MainDashboardDrilldownSelection } from "@/components/dashboard/main-dashboard/mainDashboardFiltering";
import type {
  MainDashboardFilters as MainDashboardFiltersType,
  MainDashboardOutcomeKey,
  MainDashboardSummaryViewModel,
  MainDashboardTicketsPageRequest,
} from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import {
  mainDashboardFilterKeys,
} from "@/components/dashboard/main-dashboard/mainDashboardTypes";
import { useMainDashboardSummary } from "@/components/dashboard/main-dashboard/useMainDashboardSummary";
import { useMainDashboardTickets } from "@/components/dashboard/main-dashboard/useMainDashboardTickets";

function createEmptyFilters(): MainDashboardFiltersType {
  return Object.fromEntries(
    mainDashboardFilterKeys.map((viewKey) => [viewKey, []]),
  ) as MainDashboardFiltersType;
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

function shouldHideProblemFinderTeamByDefault(team: string) {
  return team.trim().toLocaleLowerCase().includes("coc");
}

function getDefaultProblemFinderTeams(viewModel: MainDashboardSummaryViewModel) {
  const availableTeams = viewModel.filters.problemFinderTeams;
  const visibleTeams = availableTeams.filter(
    (team) => !shouldHideProblemFinderTeamByDefault(team),
  );

  if (visibleTeams.length === 0 || visibleTeams.length === availableTeams.length) {
    return [];
  }

  return visibleTeams;
}

function getDefaultYears(viewModel: MainDashboardSummaryViewModel) {
  if (viewModel.generatedFrom.years.length > 0) {
    return viewModel.generatedFrom.years;
  }

  return viewModel.filters.years.slice(0, 1);
}

function getDefaultMonths(
  viewModel: MainDashboardSummaryViewModel,
  defaultYears: string[],
) {
  const matchingMonths = viewModel.filters.months.filter((month) =>
    defaultYears.some((year) => month.startsWith(`${year}-`)),
  );

  if (matchingMonths.length > 0) {
    return [matchingMonths[matchingMonths.length - 1]];
  }

  return viewModel.filters.months.slice(-1);
}

function getDefaultPhases(viewModel: MainDashboardSummaryViewModel) {
  return viewModel.filters.phases.filter((phase) => /^(03|04)(?=[^0-9]|$)/.test(phase));
}

function getDefaultFilterValue(options: string[], preferredValue: string) {
  const normalizedPreferredValue = preferredValue.trim().toLocaleLowerCase();

  return options.find(
    (option) => option.trim().toLocaleLowerCase() === normalizedPreferredValue,
  );
}

function getDefaultChinaScopes(viewModel: MainDashboardSummaryViewModel) {
  const preferredScope = getDefaultFilterValue(viewModel.filters.chinaScopes, "China");

  return preferredScope ? [preferredScope] : [];
}

function getDefaultProjects(viewModel: MainDashboardSummaryViewModel) {
  const preferredProject = getDefaultFilterValue(viewModel.filters.projects, "IDCEVO");

  return preferredProject ? [preferredProject] : [];
}

function createDefaultFilters(
  viewModel: MainDashboardSummaryViewModel | null | undefined,
): MainDashboardFiltersType {
  const emptyFilters = createEmptyFilters();

  if (!viewModel) {
    return emptyFilters;
  }

  const defaultYears = getDefaultYears(viewModel);

  return {
    ...emptyFilters,
    years: defaultYears,
    months: getDefaultMonths(viewModel, defaultYears),
    chinaScopes: getDefaultChinaScopes(viewModel),
    projects: getDefaultProjects(viewModel),
    phases: getDefaultPhases(viewModel),
    problemFinderTeams: getDefaultProblemFinderTeams(viewModel),
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

type MainDashboardProps = {
  onSyncDateChange?: (value: string | null) => void;
};

const MainDashboard = ({ onSyncDateChange }: MainDashboardProps) => {
  const [selectedFilters, setSelectedFilters] =
    useState<MainDashboardFiltersType>(createEmptyFilters);
  const [initializedSnapshotVersion, setInitializedSnapshotVersion] = useState("");
  const [searchText, setSearchText] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [selection, setSelection] = useState<MainDashboardDrilldownSelection>({});
  const [ticketPageRequest, setTicketPageRequest] = useState<MainDashboardTicketsPageRequest>({
    page: 1,
    pageSize: 50,
    search: "",
    sortBy: "ticket_id",
    sortOrder: "asc",
    snapshotVersion: "",
  });
  const summaryQuery = useMainDashboardSummary(selectedFilters);
  const summaryData = summaryQuery.data ?? emptySummaryViewModel;
  const effectiveTicketPageRequest = {
    ...ticketPageRequest,
    snapshotVersion: summaryData.snapshotVersion,
  };
  const ticketsQuery = useMainDashboardTickets(
    selectedFilters,
    effectiveTicketPageRequest,
    { enabled: Boolean(summaryQuery.data) },
  );
  const refreshError = summaryQuery.error ?? ticketsQuery.error;

  useEffect(() => {
    setSelection({});
  }, [selectedFilters]);

  useEffect(() => {
    if (!summaryQuery.data) {
      return;
    }

    const snapshotVersion = summaryQuery.data.snapshotVersion || "missing-snapshot";
    if (initializedSnapshotVersion === snapshotVersion) {
      return;
    }

    setSelectedFilters(createDefaultFilters(summaryQuery.data));
    setSearchText("");
    setSelection({});
    setTicketPageRequest((current) => ({
      ...current,
      page: 1,
      search: "",
      sortBy: "ticket_id",
      sortOrder: "asc",
    }));
    setInitializedSnapshotVersion(snapshotVersion);
  }, [initializedSnapshotVersion, summaryQuery.data]);

  useEffect(() => {
    setTicketPageRequest((current) => ({
      ...current,
      page: 1,
    }));
  }, [selectedFilters]);

  useEffect(() => {
    setTicketPageRequest((current) => {
      if (
        current.search === searchText
      ) {
        return current;
      }
      return {
        ...current,
        page: 1,
        search: searchText,
      };
    });
  }, [searchText]);

  useEffect(() => {
    onSyncDateChange?.(
      summaryData.refreshMetadata.lastSuccessAt ?? getLatestTicketDateLabel(ticketsQuery.data?.rows ?? []),
    );
  }, [onSyncDateChange, summaryData.refreshMetadata.lastSuccessAt, ticketsQuery.data?.rows]);

  if (summaryQuery.isLoading && !summaryQuery.data) {
    return (
      <section className="workbench-panel p-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading Full Picture data...</span>
        </div>
      </section>
    );
  }

  if (summaryQuery.error && !summaryQuery.data) {
    return (
      <section className="workbench-panel p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to load Full Picture data.</AlertTitle>
          <AlertDescription>
            {summaryQuery.error.message || "Check whether the Full Picture service is available."}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const drilldownRows = selectTicketRowsForDrilldown(ticketsQuery.data?.rows ?? [], selection);
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
    setSelectedFilters(createDefaultFilters(summaryQuery.data));
    setTicketPageRequest((current) => ({
      ...current,
      page: 1,
      pageSize: 50,
      search: "",
      sortBy: "ticket_id",
      sortOrder: "asc",
    }));
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
      {refreshError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Unable to refresh Full Picture data.</AlertTitle>
          <AlertDescription>
            Showing the latest cached dashboard snapshot.
            {refreshError.message ? ` ${refreshError.message}` : ""}
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
            availableFilters={summaryData.filters}
            selectedFilters={selectedFilters}
            onToggleValue={handleToggleValue}
          />
        ) : null}
      </div>
      <MainDashboardKpis
        overview={summaryData.overview}
        teamCount={summaryData.teamOutcomeRows.length}
      />
      <TicketDetailTable
        rows={drilldownRows}
        totalRows={ticketsQuery.data?.totalRows ?? 0}
        page={ticketsQuery.data?.page ?? ticketPageRequest.page}
        pageSize={ticketsQuery.data?.pageSize ?? ticketPageRequest.pageSize}
        sortBy={ticketPageRequest.sortBy}
        sortOrder={ticketPageRequest.sortOrder}
        selection={selection}
        selectedOutcomeLabel={selectedOutcomeLabel}
        onClearSelection={() => setSelection({})}
        onPageChange={(page) => {
          setTicketPageRequest((current) => ({
            ...current,
            page,
          }));
        }}
        onPageSizeChange={(pageSize) => {
          setTicketPageRequest((current) => ({
            ...current,
            page: 1,
            pageSize,
          }));
        }}
        onSearchChange={setSearchText}
        onSortChange={(sortBy, sortOrder) => {
          setTicketPageRequest((current) => ({
            ...current,
            page: 1,
            sortBy,
            sortOrder,
          }));
        }}
      />
      <div
        data-testid="outcome-analysis-panels"
        className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start"
      >
        <OutcomePanel
          outcomeSummary={summaryData.outcomeSummary}
          selectedOutcomeKey={selection.outcomeKey}
          onToggleOutcome={handleToggleOutcome}
        />
        <TeamExpansionPanel
          teamOutcomeRows={summaryData.teamOutcomeRows}
          selectedOutcomeKey={selection.outcomeKey}
          selectedTeam={selection.team}
          onSelectTeamOutcome={handleSelectTeamOutcome}
        />
      </div>
    </section>
  );
};

export default MainDashboard;