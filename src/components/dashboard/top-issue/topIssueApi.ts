import {
  adaptRefreshMetadata,
} from "@/components/dashboard/main-dashboard/mainDashboardAdapter";
import {
  buildMainDashboardApiUrl,
  MainDashboardApiError,
} from "@/components/dashboard/main-dashboard/mainDashboardApi";

import type {
  TopIssueAnalysisPayload,
  TopIssueAnalysisQuery,
  TopIssueAnalysisViewModel,
} from "./topIssueTypes";

const TOP_ISSUE_ANALYSIS_API_PATH = "/api/full-picture/top-issue-analysis";

function throwTopIssueApiError(prefix: string, response: Response): never {
  throw new MainDashboardApiError(
    `${prefix} (${response.status} ${response.statusText})`,
    response.status,
  );
}

export async function fetchTopIssueAnalysis(
  filters: TopIssueAnalysisQuery = {},
): Promise<TopIssueAnalysisViewModel> {
  const response = await fetch(
    buildMainDashboardApiUrl(TOP_ISSUE_ANALYSIS_API_PATH, filters),
  );

  if (!response.ok) {
    throwTopIssueApiError("Top issue analysis request failed", response);
  }

  const payload = (await response.json()) as TopIssueAnalysisPayload;
  return {
    snapshotVersion: payload.snapshot_version,
    refreshMetadata: adaptRefreshMetadata(payload.refresh_metadata),
    topIssueRows: payload.top_issue_rows.map((row) => ({
      ticketId: row.ticket_id,
      ticketName: row.ticket_name,
      severity: row.severity,
      project: row.project,
      status: row.status,
      ageDays: row.age_days,
      creationTime: row.creation_time,
      ticketDate: row.ticket_date,
      classification: row.classification,
    })),
    statusDistribution: payload.status_distribution.map((row) => ({
      status: row.status,
      count: row.count,
    })),
    defectTrend: payload.defect_trend.map((row) => ({
      month: row.month,
      newCount: row.new_count,
      closedCount: row.closed_count,
      inProgressCount: row.in_progress_count,
    })),
  };
}