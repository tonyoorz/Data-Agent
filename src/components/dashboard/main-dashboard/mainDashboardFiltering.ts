import type {
  MainDashboardFilters,
  MainDashboardOutcomeKey,
  MainDashboardOutcomeSummaryRow,
  MainDashboardOverview,
  MainDashboardTeamOutcomeRow,
  MainDashboardTicketRow,
  MainDashboardViewModel,
} from "./mainDashboardTypes";

export type MainDashboardFilterState = {
  searchText: string;
  filters: MainDashboardFilters;
};

export type MainDashboardDrilldownSelection = {
  outcomeKey?: MainDashboardOutcomeKey | null;
  team?: string | null;
};

type FilteredMainDashboardData = Pick<
  MainDashboardViewModel,
  "ticketRows" | "overview" | "outcomeSummary" | "teamOutcomeRows"
>;

const OUTCOME_SERIES: ReadonlyArray<{
  key: MainDashboardOutcomeKey;
  label: string;
  flagName: keyof Pick<
    MainDashboardTicketRow,
    "isResolvedForward" | "isRejectedDirectly"
  >;
}> = [
  {
    key: "resolvedForward",
    label: "Resolved Forward (08 -> 06)",
    flagName: "isResolvedForward",
  },
  {
    key: "rejectedDirectly",
    label: "Rejected Directly (01 -> 09)",
    flagName: "isRejectedDirectly",
  },
];

function matchesListFilter(activeValues: string[], candidate: string) {
  return activeValues.length === 0 || activeValues.includes(candidate);
}

function normalizeProblemFinderTeam(team: string) {
  return team.trim();
}

function matchesProblemFinderTeamFilter(activeValues: string[], candidate: string) {
  if (activeValues.length === 0) {
    return true;
  }

  const normalizedCandidate = normalizeProblemFinderTeam(candidate);

  return activeValues.some(
    (value) => normalizeProblemFinderTeam(value) === normalizedCandidate,
  );
}

function matchesSearch(row: MainDashboardTicketRow, searchText: string) {
  const query = searchText.trim().toLocaleLowerCase();

  if (!query) {
    return true;
  }

  return (
    row.ticketId.toLocaleLowerCase().includes(query) ||
    row.ticketName.toLocaleLowerCase().includes(query)
  );
}

function matchesFilters(
  row: MainDashboardTicketRow,
  filters: MainDashboardFilters,
) {
  return (
    matchesListFilter(filters.years, row.year) &&
    matchesListFilter(filters.projects, row.project) &&
    matchesListFilter(filters.assignedEcus, row.assignedEcu) &&
    matchesProblemFinderTeamFilter(
      filters.problemFinderTeams,
      row.problemFinderTeam,
    ) &&
    matchesListFilter(filters.aidas, row.aida) &&
    matchesListFilter(filters.phases, row.phase) &&
    matchesListFilter(filters.solutionClusters, row.solutionCluster) &&
    matchesListFilter(filters.pus, row.pu) &&
    matchesListFilter(filters.markets, row.market) &&
    matchesListFilter(filters.leadModels, row.leadModel) &&
    matchesListFilter(filters.groups, row.group)
  );
}

function matchesOutcome(
  row: MainDashboardTicketRow,
  outcomeKey?: MainDashboardOutcomeKey | null,
) {
  if (!outcomeKey) {
    return true;
  }

  return outcomeKey === "resolvedForward"
    ? row.isResolvedForward
    : row.isRejectedDirectly;
}

function toPercent(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 10000) / 100;
}

function sortableValue(value: string) {
  const normalized = value.trim();

  if (/^\d+$/.test(normalized)) {
    return [0, Number(normalized)] as const;
  }

  return [1, normalized.toLocaleLowerCase()] as const;
}

function buildOverview(ticketRows: MainDashboardTicketRow[]): MainDashboardOverview {
  const ticketCount = ticketRows.length;
  const resolvedForwardCount = ticketRows.filter(
    (row) => row.isResolvedForward,
  ).length;
  const rejectedDirectlyCount = ticketRows.filter(
    (row) => row.isRejectedDirectly,
  ).length;

  return {
    ticketCount,
    resolvedForwardCount,
    rejectedDirectlyCount,
    resolvedForwardPercent: toPercent(resolvedForwardCount, ticketCount),
    rejectedDirectlyPercent: toPercent(rejectedDirectlyCount, ticketCount),
  };
}

function buildOutcomeSummary(
  ticketRows: MainDashboardTicketRow[],
): MainDashboardOutcomeSummaryRow[] {
  const denominator = ticketRows.length;

  return OUTCOME_SERIES.map((series) => {
    const count = ticketRows.filter((row) => row[series.flagName]).length;

    return {
      key: series.key,
      label: series.label,
      count,
      percent: toPercent(count, denominator),
      denominator,
    };
  });
}

function buildTeamOutcomeRows(
  ticketRows: MainDashboardTicketRow[],
): MainDashboardTeamOutcomeRow[] {
  const grouped = ticketRows.reduce(
    (accumulator, row) => {
      const normalizedTeam = normalizeProblemFinderTeam(row.problemFinderTeam);
      const current = accumulator.get(normalizedTeam) ?? {
        problemFinderTeam: normalizedTeam,
        totalTickets: 0,
        resolvedForwardCount: 0,
        rejectedDirectlyCount: 0,
        resolvedForwardTeamPercent: 0,
        rejectedDirectlyTeamPercent: 0,
        teamDenominator: 0,
      };

      current.totalTickets += 1;
      if (row.isResolvedForward) {
        current.resolvedForwardCount += 1;
      }
      if (row.isRejectedDirectly) {
        current.rejectedDirectlyCount += 1;
      }

      accumulator.set(normalizedTeam, current);
      return accumulator;
    },
    new Map<string, MainDashboardTeamOutcomeRow>(),
  );

  return Array.from(grouped.values())
    .map((row) => ({
      ...row,
      resolvedForwardTeamPercent: toPercent(
        row.resolvedForwardCount,
        row.totalTickets,
      ),
      rejectedDirectlyTeamPercent: toPercent(
        row.rejectedDirectlyCount,
        row.totalTickets,
      ),
      teamDenominator: row.totalTickets,
    }))
    .sort((left, right) => {
      if (right.totalTickets !== left.totalTickets) {
        return right.totalTickets - left.totalTickets;
      }

      const leftValue = sortableValue(left.problemFinderTeam);
      const rightValue = sortableValue(right.problemFinderTeam);

      if (leftValue[0] !== rightValue[0]) {
        return leftValue[0] - rightValue[0];
      }

      if (leftValue[1] < rightValue[1]) {
        return -1;
      }

      if (leftValue[1] > rightValue[1]) {
        return 1;
      }

      return 0;
    });
}

export function applyMainDashboardFilters(
  viewModel: MainDashboardViewModel,
  state: MainDashboardFilterState,
): FilteredMainDashboardData {
  const ticketRows = viewModel.ticketRows.filter(
    (row) =>
      matchesSearch(row, state.searchText) &&
      matchesFilters(row, state.filters),
  );

  return {
    ticketRows,
    overview: buildOverview(ticketRows),
    outcomeSummary: buildOutcomeSummary(ticketRows),
    teamOutcomeRows: buildTeamOutcomeRows(ticketRows),
  };
}

export function selectTicketRowsForDrilldown(
  ticketRows: MainDashboardTicketRow[],
  selection: MainDashboardDrilldownSelection = {},
) {
  const normalizedTeam = selection.team
    ? normalizeProblemFinderTeam(selection.team)
    : undefined;

  return ticketRows.filter(
    (row) =>
      (!normalizedTeam ||
        normalizeProblemFinderTeam(row.problemFinderTeam) === normalizedTeam) &&
      matchesOutcome(row, selection.outcomeKey),
  );
}