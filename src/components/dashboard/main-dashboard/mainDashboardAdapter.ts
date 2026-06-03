import type {
  MainDashboardFilters,
  MainDashboardFiltersPayload,
  MainDashboardOutcomeKey,
  MainDashboardOutcomePayloadKey,
  MainDashboardPayload,
  MainDashboardRefreshMetadata,
  MainDashboardRefreshMetadataPayload,
  MainDashboardSummaryPayload,
  MainDashboardSummaryViewModel,
  MainDashboardTicketRow,
  MainDashboardTicketsPage,
  MainDashboardTicketsPagePayload,
  MainDashboardViewModel,
} from "./mainDashboardTypes";
import {
  mainDashboardFilterFieldMappings,
  mainDashboardOutcomeKeyMap,
} from "./mainDashboardTypes";
import { collectTicketMonthOptions } from "./mainDashboardDateUtils";
import { collectChinaScopeOptions } from "./mainDashboardChinaScope";

const prioritizedRequirementLabels = ["Top Topic", "DOC_PreCon_Prio_CN_26-11"] as const;

function normalizeRequirementDisplayOrder(requirement?: string | null) {
  const normalizedRequirement = String(requirement ?? "").trim();

  if (!normalizedRequirement) {
    return null;
  }

  const tokens = normalizedRequirement
    .split("|")
    .map((token) => token.trim())
    .filter(Boolean);

  if (!tokens.length) {
    return null;
  }

  const seenTokens = new Set<string>();
  const orderedTokens: string[] = [];

  for (const prioritizedLabel of prioritizedRequirementLabels) {
    const matchedToken = tokens.find(
      (token) => token.localeCompare(prioritizedLabel, undefined, { sensitivity: "base" }) === 0,
    );

    if (!matchedToken) {
      continue;
    }

    const normalizedToken = prioritizedLabel.toLocaleLowerCase();
    if (!seenTokens.has(normalizedToken)) {
      seenTokens.add(normalizedToken);
      orderedTokens.push(prioritizedLabel);
    }
  }

  for (const token of tokens) {
    const normalizedToken = token.toLocaleLowerCase();

    if (seenTokens.has(normalizedToken)) {
      continue;
    }

    seenTokens.add(normalizedToken);
    orderedTokens.push(token);
  }

  return orderedTokens.join(" | ");
}

function adaptFilterValues(
  filters: MainDashboardFiltersPayload,
): Omit<MainDashboardFilters, "months" | "chinaScopes"> {
  return {
    years: filters.years ?? [],
    creationTimeStart: filters.creation_time_start ?? "",
    creationTimeEnd: filters.creation_time_end ?? "",
    requirements: filters.requirements ?? [],
    projects: filters.projects ?? [],
    assignedEcus: filters.assigned_ecus ?? [],
    problemFinderTeams: filters.problem_finder_teams ?? [],
    aidas: filters.aidas ?? [],
    phases: filters.phases ?? [],
    solutionClusters: filters.solution_clusters ?? [],
    pus: filters.pus ?? [],
    markets: filters.markets ?? [],
    leadModels: filters.lead_models ?? [],
    groups: filters.groups ?? [],
  };
}

function adaptOutcomeKey(key: string): MainDashboardOutcomeKey {
  if (!Object.prototype.hasOwnProperty.call(mainDashboardOutcomeKeyMap, key)) {
    throw new Error(`Unknown outcome key: ${key}`);
  }

  return mainDashboardOutcomeKeyMap[key as MainDashboardOutcomePayloadKey];
}

function adaptTicketDate(row: MainDashboardPayload["ticket_rows"][number]) {
  return row.ticket_date ?? row.updated_at ?? row.created_at ?? row.latest_date ?? null;
}

function adaptTicketRow(row: MainDashboardPayload["ticket_rows"][number]): MainDashboardTicketRow {
  return {
    ticketId: row.ticket_id,
    ticketName: row.ticket_name,
    status: row.status,
    creationTime: row.creation_time ?? row.created_at ?? null,
    ticketDate: adaptTicketDate(row),
    problemFinderTeam: row.problem_finder_team,
    classification: row.classification ?? null,
    problemSeverity: row.problem_severity ?? null,
    group: row.group,
    phase: row.phase,
    requirement: normalizeRequirementDisplayOrder(row.requirement),
    isResolvedForward: row.is_resolved_forward,
    isRejectedDirectly: row.is_rejected_directly,
    year: row.year,
    project: row.project,
    assignedEcu: row.assigned_ecu,
    aida: row.aida,
    defectCategory: row.defect_category ?? null,
    solutionCluster: row.solution_cluster,
    pu: row.pu,
    market: row.market,
    leadModel: row.lead_model,
  };
}

export function adaptRefreshMetadata(
  payload: MainDashboardRefreshMetadataPayload,
): MainDashboardRefreshMetadata {
  return {
    activeSnapshotVersion: payload.active_snapshot_version,
    refreshStatus: payload.refresh_status,
    sourceDbPath: payload.source_db_path,
    sourceDbMtime: payload.source_db_mtime,
    outcomesRefreshedAt: payload.outcomes_refreshed_at,
    summaryCacheRefreshedAt: payload.summary_cache_refreshed_at,
    lastSuccessAt: payload.last_success_at,
    lastError: payload.last_error,
  };
}

export function adaptMainDashboardPayload(
  payload: MainDashboardPayload,
): MainDashboardViewModel {
  const ticketRows = payload.ticket_rows.map(adaptTicketRow);
  const months = collectTicketMonthOptions(ticketRows, (row) => row.creationTime);
  const chinaScopes = collectChinaScopeOptions(ticketRows);

  return {
    generatedFrom: {
      defectDbPath: payload.generated_from.defect_db_path,
      historyDbPath: payload.generated_from.history_db_path,
      ...adaptFilterValues(payload.generated_from),
      months,
      chinaScopes,
    },
    filters: {
      ...adaptFilterValues(payload.filters),
      months,
      chinaScopes,
    },
    overview: {
      ticketCount: payload.overview.ticket_count,
      resolvedForwardCount: payload.overview.resolved_forward_count,
      rejectedDirectlyCount: payload.overview.rejected_directly_count,
      resolvedForwardPercent: payload.overview.resolved_forward_percent,
      rejectedDirectlyPercent: payload.overview.rejected_directly_percent,
    },
    outcomeSummary: payload.outcome_summary.map((row) => ({
      key: adaptOutcomeKey(row.key),
      label: row.label,
      count: row.count,
      percent: row.percent,
      denominator: row.denominator,
    })),
    teamOutcomeRows: payload.team_outcome_rows.map((row) => ({
      problemFinderTeam: row.problem_finder_team,
      totalTickets: row.total_tickets,
      resolvedForwardCount: row.resolved_forward_count,
      rejectedDirectlyCount: row.rejected_directly_count,
      resolvedForwardTeamPercent: row.resolved_forward_team_percent,
      rejectedDirectlyTeamPercent: row.rejected_directly_team_percent,
      teamDenominator: row.team_denominator,
    })),
    ticketRows,
  };
}


export function adaptMainDashboardSummaryPayload(
  payload: MainDashboardSummaryPayload,
): MainDashboardSummaryViewModel {
  const months = payload.filters.months ?? payload.generated_from.months ?? [];
  const chinaScopes = payload.filters.china_scopes ?? payload.generated_from.china_scopes ?? [];

  return {
    snapshotVersion: payload.snapshot_version,
    refreshMetadata: adaptRefreshMetadata(payload.refresh_metadata),
    generatedFrom: {
      defectDbPath: payload.generated_from.defect_db_path,
      historyDbPath: payload.generated_from.history_db_path,
      ...adaptFilterValues(payload.generated_from),
      months: payload.generated_from.months ?? months,
      chinaScopes: payload.generated_from.china_scopes ?? chinaScopes,
    },
    filters: {
      ...adaptFilterValues(payload.filters),
      months,
      chinaScopes,
    },
    overview: {
      ticketCount: payload.overview.ticket_count,
      resolvedForwardCount: payload.overview.resolved_forward_count,
      rejectedDirectlyCount: payload.overview.rejected_directly_count,
      resolvedForwardPercent: payload.overview.resolved_forward_percent,
      rejectedDirectlyPercent: payload.overview.rejected_directly_percent,
    },
    outcomeSummary: payload.outcome_summary.map((row) => ({
      key: adaptOutcomeKey(row.key),
      label: row.label,
      count: row.count,
      percent: row.percent,
      denominator: row.denominator,
    })),
    teamOutcomeRows: payload.team_outcome_rows.map((row) => ({
      problemFinderTeam: row.problem_finder_team,
      totalTickets: row.total_tickets,
      resolvedForwardCount: row.resolved_forward_count,
      rejectedDirectlyCount: row.rejected_directly_count,
      resolvedForwardTeamPercent: row.resolved_forward_team_percent,
      rejectedDirectlyTeamPercent: row.rejected_directly_team_percent,
      teamDenominator: row.team_denominator,
    })),
  };
}


export function adaptMainDashboardTicketsPagePayload(
  payload: MainDashboardTicketsPagePayload,
): MainDashboardTicketsPage {
  return {
    snapshotVersion: payload.snapshot_version,
    refreshMetadata: adaptRefreshMetadata(payload.refresh_metadata),
    page: payload.page,
    pageSize: payload.page_size,
    totalRows: payload.total_rows,
    totalPages: payload.total_pages,
    rows: payload.rows.map(adaptTicketRow),
    priorityRows: (payload.priority_rows ?? []).map(adaptTicketRow),
  };
}