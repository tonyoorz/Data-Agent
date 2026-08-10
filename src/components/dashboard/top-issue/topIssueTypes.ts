import type {
  MainDashboardFilters,
  MainDashboardRefreshMetadata,
  MainDashboardRefreshMetadataPayload,
} from "@/components/dashboard/main-dashboard/mainDashboardTypes";

export type TopIssueTrendRowPayload = {
  month: string;
  new_count: number;
  closed_count: number;
  in_progress_count: number;
};

export type TopIssueStatusDistributionRowPayload = {
  status: string;
  count: number;
};

export type TopIssueRowPayload = {
  ticket_id: string;
  ticket_name: string;
  severity: string;
  project: string;
  status: string;
  age_days: number;
  creation_time: string;
  ticket_date: string;
  classification: string;
};

export type TopIssueAnalysisPayload = {
  snapshot_version: string;
  refresh_metadata: MainDashboardRefreshMetadataPayload;
  top_issue_rows: TopIssueRowPayload[];
  status_distribution: TopIssueStatusDistributionRowPayload[];
  defect_trend: TopIssueTrendRowPayload[];
};

export type TopIssueTrendRow = {
  month: string;
  newCount: number;
  closedCount: number;
  inProgressCount: number;
};

export type TopIssueStatusDistributionRow = {
  status: string;
  count: number;
};

export type TopIssueRow = {
  ticketId: string;
  ticketName: string;
  severity: string;
  project: string;
  status: string;
  ageDays: number;
  creationTime: string;
  ticketDate: string;
  classification: string;
};

export type TopIssueAnalysisViewModel = {
  snapshotVersion: string;
  refreshMetadata: MainDashboardRefreshMetadata;
  topIssueRows: TopIssueRow[];
  statusDistribution: TopIssueStatusDistributionRow[];
  defectTrend: TopIssueTrendRow[];
};

export type TopIssueAnalysisQuery = Partial<MainDashboardFilters>;