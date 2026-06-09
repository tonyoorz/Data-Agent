import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchTopIssueAnalysis } from "@/components/dashboard/top-issue/topIssueApi";

function createJsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("fetchTopIssueAnalysis", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the top issue analysis endpoint with Full Picture filter params", async () => {
    vi.mocked(fetch).mockResolvedValue(
      createJsonResponse({
        snapshot_version: "snapshot-1",
        generated_from: {
          defect_db_path: "defect.db",
          history_db_path: "history.db",
          years: ["2026"],
          projects: ["IDCEVO"],
          assigned_ecus: [],
          problem_finder_teams: [],
          aidas: [],
          phases: ["03-In Analysis", "04-In Progress"],
          solution_clusters: [],
          pus: [],
          markets: [],
          lead_models: [],
          groups: [],
        },
        refresh_metadata: {
          active_snapshot_version: "snapshot-1",
          refresh_status: "ready",
        },
        top_issue_rows: [
          {
            ticket_id: "D-1",
            ticket_name: "Wakeup issue",
            severity: "Critical",
            project: "IDCEVO",
            status: "03-In Analysis",
            age_days: 12,
            creation_time: "2026-05-01T00:00:00Z",
            ticket_date: "2026-05-13T00:00:00Z",
            classification: "Functional",
          },
        ],
        status_distribution: [
          { status: "03-In Analysis", count: 1 },
        ],
        defect_trend: [
          { month: "2026-05", new_count: 1, closed_count: 0, in_progress_count: 1 },
        ],
      }),
    );

    const payload = await fetchTopIssueAnalysis({
      years: ["2026"],
      projects: ["IDCEVO"],
      phases: ["03-In Analysis", "04-In Progress"],
      creationTimeStart: "2026-05-01",
      creationTimeEnd: "2026-05-31",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/full-picture/top-issue-analysis?years=2026&projects=IDCEVO&phases=03-In+Analysis%2C04-In+Progress&creation_time_start=2026-05-01&creation_time_end=2026-05-31",
    );
    expect(payload.topIssueRows[0]).toMatchObject({
      ticketId: "D-1",
      ticketName: "Wakeup issue",
      severity: "Critical",
      ageDays: 12,
    });
    expect(payload.statusDistribution).toEqual([
      { status: "03-In Analysis", count: 1 },
    ]);
    expect(payload.defectTrend).toEqual([
      { month: "2026-05", newCount: 1, closedCount: 0, inProgressCount: 1 },
    ]);
  });
});