export type MainDashboardOutcomePayloadKey =
  | "resolved_forward"
  | "rejected_directly";

export type MainDashboardOutcomeKey = "resolvedForward" | "rejectedDirectly";

export type MainDashboardFilters = {
  years: string[];
  months: string[];
  chinaScopes: string[];
  projects: string[];
  assignedEcus: string[];
  problemFinderTeams: string[];
  aidas: string[];
  phases: string[];
  solutionClusters: string[];
  pus: string[];
  markets: string[];
  leadModels: string[];
  groups: string[];
};

export type MainDashboardFiltersPayload = {
  years: string[];
  projects: string[];
  assigned_ecus: string[];
  problem_finder_teams: string[];
  aidas: string[];
  phases: string[];
  solution_clusters: string[];
  pus: string[];
  markets: string[];
  lead_models: string[];
  groups: string[];
};

export const mainDashboardFilterKeys = [
  "years",
  "months",
  "chinaScopes",
  "projects",
  "assignedEcus",
  "problemFinderTeams",
  "aidas",
  "phases",
  "solutionClusters",
  "pus",
  "markets",
  "leadModels",
  "groups",
] as const satisfies ReadonlyArray<keyof MainDashboardFilters>;

export const mainDashboardFilterFieldMappings = [
  { viewKey: "years", payloadKey: "years", label: "Year" },
  { viewKey: "projects", payloadKey: "projects", label: "Project" },
  { viewKey: "assignedEcus", payloadKey: "assigned_ecus", label: "Assigned ECU" },
  {
    viewKey: "problemFinderTeams",
    payloadKey: "problem_finder_teams",
    label: "Problem Finder Team",
  },
  { viewKey: "aidas", payloadKey: "aidas", label: "AIDA" },
  { viewKey: "phases", payloadKey: "phases", label: "Phase" },
  {
    viewKey: "solutionClusters",
    payloadKey: "solution_clusters",
    label: "Solution Cluster",
  },
  { viewKey: "pus", payloadKey: "pus", label: "PU" },
  { viewKey: "markets", payloadKey: "markets", label: "Market" },
  { viewKey: "leadModels", payloadKey: "lead_models", label: "Lead Model" },
  { viewKey: "groups", payloadKey: "groups", label: "Group" },
] as const satisfies ReadonlyArray<{
  viewKey: Exclude<keyof MainDashboardFilters, "months" | "chinaScopes">;
  payloadKey: keyof MainDashboardFiltersPayload;
  label: string;
}>;

export const mainDashboardUiFilterFieldMappings = [
  { viewKey: "years", label: "Year" },
  { viewKey: "months", label: "Month" },
  { viewKey: "chinaScopes", label: "China/Global" },
  { viewKey: "projects", label: "Project" },
  { viewKey: "assignedEcus", label: "Assigned ECU" },
  { viewKey: "problemFinderTeams", label: "Problem Finder Team" },
  { viewKey: "aidas", label: "AIDA" },
  { viewKey: "phases", label: "Phase" },
  { viewKey: "solutionClusters", label: "Solution Cluster" },
  { viewKey: "pus", label: "PU" },
  { viewKey: "markets", label: "Market" },
  { viewKey: "leadModels", label: "Lead Model" },
  { viewKey: "groups", label: "Group" },
] as const satisfies ReadonlyArray<{
  viewKey: keyof MainDashboardFilters;
  label: string;
}>;

export type MainDashboardGeneratedFromPayload = MainDashboardFiltersPayload & {
  defect_db_path: string;
  history_db_path: string;
};

export type MainDashboardOverviewPayload = {
  ticket_count: number;
  resolved_forward_count: number;
  rejected_directly_count: number;
  resolved_forward_percent: number;
  rejected_directly_percent: number;
};

export const mainDashboardOutcomeKeyMap = {
  resolved_forward: "resolvedForward",
  rejected_directly: "rejectedDirectly",
} as const satisfies Record<
  MainDashboardOutcomePayloadKey,
  MainDashboardOutcomeKey
>;

export type MainDashboardOutcomeSummaryRowPayload = {
  key: MainDashboardOutcomePayloadKey;
  label: string;
  count: number;
  percent: number;
  denominator: number;
};

export type MainDashboardTeamOutcomeRowPayload = {
  problem_finder_team: string;
  total_tickets: number;
  resolved_forward_count: number;
  rejected_directly_count: number;
  resolved_forward_team_percent: number;
  rejected_directly_team_percent: number;
  team_denominator: number;
};

export type MainDashboardTicketRowPayload = {
  ticket_id: string;
  ticket_name: string;
  status: string;
  ticket_date?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  latest_date?: string | null;
  problem_finder_team: string;
  group: string;
  phase: string;
  is_resolved_forward: boolean;
  is_rejected_directly: boolean;
  year: string;
  project: string;
  assigned_ecu: string;
  aida: string;
  defect_category?: string | null;
  solution_cluster: string;
  pu: string;
  market: string;
  lead_model: string;
};

export type MainDashboardPayload = {
  generated_from: MainDashboardGeneratedFromPayload;
  filters: MainDashboardFiltersPayload;
  overview: MainDashboardOverviewPayload;
  outcome_summary: MainDashboardOutcomeSummaryRowPayload[];
  team_outcome_rows: MainDashboardTeamOutcomeRowPayload[];
  ticket_rows: MainDashboardTicketRowPayload[];
};

export type MainDashboardGeneratedFrom = MainDashboardFilters & {
  defectDbPath: string;
  historyDbPath: string;
};

export type MainDashboardOverview = {
  ticketCount: number;
  resolvedForwardCount: number;
  rejectedDirectlyCount: number;
  resolvedForwardPercent: number;
  rejectedDirectlyPercent: number;
};

export type MainDashboardOutcomeSummaryRow = {
  key: MainDashboardOutcomeKey;
  label: string;
  count: number;
  percent: number;
  denominator: number;
};

export type MainDashboardTeamOutcomeRow = {
  problemFinderTeam: string;
  totalTickets: number;
  resolvedForwardCount: number;
  rejectedDirectlyCount: number;
  resolvedForwardTeamPercent: number;
  rejectedDirectlyTeamPercent: number;
  teamDenominator: number;
};

export type MainDashboardTicketRow = {
  ticketId: string;
  ticketName: string;
  status: string;
  ticketDate?: string | null;
  problemFinderTeam: string;
  group: string;
  phase: string;
  isResolvedForward: boolean;
  isRejectedDirectly: boolean;
  year: string;
  project: string;
  assignedEcu: string;
  aida: string;
  defectCategory?: string | null;
  solutionCluster: string;
  pu: string;
  market: string;
  leadModel: string;
};

export type MainDashboardViewModel = {
  generatedFrom: MainDashboardGeneratedFrom;
  filters: MainDashboardFilters;
  overview: MainDashboardOverview;
  outcomeSummary: MainDashboardOutcomeSummaryRow[];
  teamOutcomeRows: MainDashboardTeamOutcomeRow[];
  ticketRows: MainDashboardTicketRow[];
};