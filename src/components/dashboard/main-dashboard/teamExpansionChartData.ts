import type { MainDashboardTeamOutcomeRow } from "./mainDashboardTypes";

export type TeamExpansionChartRow = {
  team: string;
  totalTickets: number;
  teamDenominator: number;
  resolvedForwardPercent: number;
  rejectedDirectlyPercent: number;
  resolvedForwardValue: number;
  rejectedDirectlyValue: number;
};

export function createTeamExpansionChartData(
  teamOutcomeRows: MainDashboardTeamOutcomeRow[],
) {
  const rows: TeamExpansionChartRow[] = teamOutcomeRows.map((row) => ({
    team: row.problemFinderTeam,
    totalTickets: row.totalTickets,
    teamDenominator: row.teamDenominator,
    resolvedForwardPercent: row.resolvedForwardTeamPercent,
    rejectedDirectlyPercent: row.rejectedDirectlyTeamPercent,
    resolvedForwardValue: row.resolvedForwardCount,
    rejectedDirectlyValue: row.rejectedDirectlyCount,
  }));

  const maxTicketCount = rows.reduce((currentMax, row) => {
    return Math.max(
      currentMax,
      row.resolvedForwardValue,
      row.rejectedDirectlyValue,
    );
  }, 0);

  return { rows, maxTicketCount };
}
