import type {
  MainDashboardFilters,
  MainDashboardFiltersPayload,
  MainDashboardOutcomeKey,
  MainDashboardOutcomePayloadKey,
  MainDashboardPayload,
  MainDashboardViewModel,
} from "./mainDashboardTypes";
import {
  mainDashboardFilterFieldMappings,
  mainDashboardOutcomeKeyMap,
} from "./mainDashboardTypes";

function adaptFilterValues(filters: MainDashboardFiltersPayload): MainDashboardFilters {
  return Object.fromEntries(
    mainDashboardFilterFieldMappings.map(({ viewKey, payloadKey }) => [
      viewKey,
      filters[payloadKey],
    ]),
  ) as MainDashboardFilters;
}

function adaptOutcomeKey(key: string): MainDashboardOutcomeKey {
  if (!Object.prototype.hasOwnProperty.call(mainDashboardOutcomeKeyMap, key)) {
    throw new Error(`Unknown outcome key: ${key}`);
  }

  return mainDashboardOutcomeKeyMap[key as MainDashboardOutcomePayloadKey];
}

export function adaptMainDashboardPayload(
  payload: MainDashboardPayload,
): MainDashboardViewModel {
  return {
    generatedFrom: {
      defectDbPath: payload.generated_from.defect_db_path,
      historyDbPath: payload.generated_from.history_db_path,
      ...adaptFilterValues(payload.generated_from),
    },
    filters: adaptFilterValues(payload.filters),
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
    ticketRows: payload.ticket_rows.map((row) => ({
      ticketId: row.ticket_id,
      ticketName: row.ticket_name,
      status: row.status,
      problemFinderTeam: row.problem_finder_team,
      group: row.group,
      phase: row.phase,
      isResolvedForward: row.is_resolved_forward,
      isRejectedDirectly: row.is_rejected_directly,
      year: row.year,
      project: row.project,
      assignedEcu: row.assigned_ecu,
      aida: row.aida,
      solutionCluster: row.solution_cluster,
      pu: row.pu,
      market: row.market,
      leadModel: row.lead_model,
    })),
  };
}