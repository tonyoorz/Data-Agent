import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MainDashboard from "@/components/dashboard/pages/MainDashboard";

function createSummaryPayload() {
  return {
    snapshot_version: "snapshot-20260528-1",
    generated_from: {
      defect_db_path: "defect.db",
      history_db_path: "history.db",
      years: ["2026"],
      months: ["2026-01", "2026-03", "2026-05"],
      china_scopes: ["China"],
      projects: ["IDCEVO", "U12"],
      assigned_ecus: ["ECU-A"],
      problem_finder_teams: ["DTSV_China"],
      aidas: ["Digital"],
      phases: ["03-In Analysis", "04-In Progress"],
      solution_clusters: ["Integration"],
      pus: ["PU1"],
      markets: ["CN"],
      lead_models: ["LM1"],
      groups: ["Integration"],
    },
    refresh_metadata: {
      active_snapshot_version: "snapshot-20260528-1",
      refresh_status: "ready",
      last_success_at: "2026-05-28T00:00:00Z",
    },
    filters: {
      years: ["2025", "2026"],
      months: ["2026-01", "2026-03", "2026-05"],
      china_scopes: ["China", "Global"],
      projects: ["IDCEVO", "U12"],
      assigned_ecus: ["ECU-A"],
      problem_finder_teams: ["DTSV_China"],
      aidas: ["Digital"],
      phases: ["03-In Analysis", "04-In Progress", "05-Open"],
      solution_clusters: ["Integration"],
      pus: ["PU1"],
      markets: ["CN"],
      lead_models: ["LM1"],
      groups: ["Integration"],
    },
    overview: {
      ticket_count: 1,
      resolved_forward_count: 1,
      rejected_directly_count: 0,
      resolved_forward_percent: 100,
      rejected_directly_percent: 0,
    },
    outcome_summary: [
      {
        key: "resolved_forward",
        label: "Resolved Forward (08 -> 06)",
        count: 1,
        percent: 100,
        denominator: 1,
      },
      {
        key: "rejected_directly",
        label: "Rejected Directly (01 -> 09)",
        count: 0,
        percent: 0,
        denominator: 1,
      },
    ],
    team_outcome_rows: [
      {
        problem_finder_team: "DTSV_China",
        total_tickets: 1,
        resolved_forward_count: 1,
        rejected_directly_count: 0,
        resolved_forward_team_percent: 100,
        rejected_directly_team_percent: 0,
        team_denominator: 1,
      },
    ],
  };
}

function createTicketsPagePayload() {
  return {
    snapshot_version: "snapshot-20260528-1",
    generated_from: {
      defect_db_path: "defect.db",
      history_db_path: "history.db",
      years: ["2026"],
      projects: ["G68"],
      assigned_ecus: ["ECU-A"],
      problem_finder_teams: ["DTSV_China"],
      aidas: ["Digital"],
      phases: ["Validation"],
      solution_clusters: ["Integration"],
      pus: ["PU1"],
      markets: ["CN"],
      lead_models: ["LM1"],
      groups: ["Integration"],
    },
    refresh_metadata: {
      active_snapshot_version: "snapshot-20260528-1",
      refresh_status: "ready",
      last_success_at: "2026-05-28T00:00:00Z",
    },
    page: 1,
    page_size: 50,
    total_rows: 1,
    total_pages: 1,
    rows: [
      {
        ticket_id: "1001",
        ticket_name: "Alpha power reset",
        status: "03-In Analysis",
        problem_finder_team: "DTSV_China",
        group: "Integration",
        phase: "Validation",
        is_resolved_forward: true,
        is_rejected_directly: false,
        year: "2026",
        project: "IDCEVO",
        assigned_ecu: "ECU-A",
        aida: "Digital",
        creation_time: "2026-05-10T10:15:00Z",
        classification: "Showstopper_Candidate",
        problem_severity: "05-unsatisfactory",
        solution_cluster: "Integration",
        pu: "PU1",
        market: "CN",
        lead_model: "LM1",
      },
    ],
  };
}

function createFetchResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

function createRouteAwareFetchMock() {
  return vi.fn(async (input: string | URL | Request) => {
    const requestUrl = String(input);

    if (requestUrl.startsWith("/api/full-picture/dashboard/summary")) {
      return createFetchResponse(createSummaryPayload());
    }

    if (requestUrl.startsWith("/api/full-picture/dashboard/tickets")) {
      return createFetchResponse(createTicketsPagePayload());
    }

    throw new Error(`Unexpected fetch URL: ${requestUrl}`);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 0,
      },
    },
  });
}

function renderMainDashboard(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MainDashboard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MainDashboard split data loading", () => {
  it("loads summary first and then requests the first ticket page", async () => {
    vi.mocked(fetch).mockImplementation(createRouteAwareFetchMock());

    renderMainDashboard(createQueryClient());

    expect(screen.getByText("Loading Full Picture data...")).toBeInTheDocument();

    expect(await screen.findByRole("article", { name: "Tickets in scope" })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/full-picture/dashboard/summary");
    });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/full-picture/dashboard/summary?years=2026&months=2026-05&china_scopes=China&projects=IDCEVO&phases=03-In+Analysis%2C04-In+Progress",
      );
    });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/full-picture/dashboard/tickets?years=2026&months=2026-05&china_scopes=China&projects=IDCEVO&phases=03-In+Analysis%2C04-In+Progress&page=1&page_size=50&sort_by=ticket_id&sort_order=asc&snapshot_version=snapshot-20260528-1",
      );
    });
    expect(screen.getByRole("article", { name: "Tickets in scope" })).toHaveTextContent("1");
  });

  it("restores the default year month and phase filters after summary load", async () => {
    vi.mocked(fetch).mockImplementation(createRouteAwareFetchMock());

    renderMainDashboard(createQueryClient());

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/full-picture/dashboard/summary?years=2026&months=2026-05&china_scopes=China&projects=IDCEVO&phases=03-In+Analysis%2C04-In+Progress",
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Year filter" })).toHaveTextContent("2026");
    });
    expect(screen.getByRole("button", { name: "Month filter" })).toHaveTextContent("2026-05");
    expect(screen.getByRole("button", { name: "China/Global filter" })).toHaveTextContent("China");
    expect(screen.getByRole("button", { name: "Project filter" })).toHaveTextContent("IDCEVO");
    expect(screen.getByRole("button", { name: "Phase filter" })).toHaveTextContent("03-In Analysis +1");
  });

  it("shows a fatal alert when the initial summary load fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Network down"));

    renderMainDashboard(createQueryClient());

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent("Unable to load Full Picture data.");
    expect(alert).toHaveTextContent("Network down");
  });

  it("keeps cached summary visible when a summary refresh fails", async () => {
    let summaryCallCount = 0;
    vi.mocked(fetch).mockImplementation(
      async (input: string | URL | Request) => {
        const requestUrl = String(input);

        if (requestUrl.startsWith("/api/full-picture/dashboard/summary")) {
          summaryCallCount += 1;
          if (summaryCallCount >= 3) {
            throw new TypeError("Refresh failed");
          }
          return createFetchResponse(createSummaryPayload());
        }

        if (requestUrl.startsWith("/api/full-picture/dashboard/tickets")) {
          return createFetchResponse(createTicketsPagePayload());
        }

        throw new Error(`Unexpected fetch URL: ${requestUrl}`);
      },
    );

    const queryClient = createQueryClient();
    renderMainDashboard(queryClient);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/full-picture/dashboard/summary?years=2026&months=2026-05&china_scopes=China&projects=IDCEVO&phases=03-In+Analysis%2C04-In+Progress",
      );
    });
    expect(await screen.findByRole("article", { name: "Tickets in scope" })).toBeInTheDocument();

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["main-dashboard", "summary"] });
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to refresh Full Picture data.",
      );
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Showing the latest cached dashboard snapshot. Refresh failed",
    );
    expect(screen.getByRole("article", { name: "Tickets in scope" })).toHaveTextContent("1");
    expect(screen.getByText("Ticket Detail")).toBeInTheDocument();
  });

  it("keeps the current dashboard visible while a filter change refresh is in flight", async () => {
    const deferredSummary = createDeferred<Response>();
    let filteredSummaryRequested = false;

    vi.mocked(fetch).mockImplementation(
      async (input: string | URL | Request) => {
        const requestUrl = String(input);

        if (requestUrl === "/api/full-picture/dashboard/summary") {
          return createFetchResponse(createSummaryPayload());
        }

        if (
          requestUrl ===
          "/api/full-picture/dashboard/summary?years=2026&months=2026-05&china_scopes=China&projects=IDCEVO&phases=03-In+Analysis%2C04-In+Progress"
        ) {
          return createFetchResponse(createSummaryPayload());
        }

        if (
          requestUrl ===
          "/api/full-picture/dashboard/summary?years=2026%2C2025&months=2026-05&china_scopes=China&projects=IDCEVO&phases=03-In+Analysis%2C04-In+Progress"
        ) {
          filteredSummaryRequested = true;
          return deferredSummary.promise;
        }

        if (requestUrl.startsWith("/api/full-picture/dashboard/tickets")) {
          return createFetchResponse(createTicketsPagePayload());
        }

        throw new Error(`Unexpected fetch URL: ${requestUrl}`);
      },
    );

    renderMainDashboard(createQueryClient());

    expect(await screen.findByRole("article", { name: "Tickets in scope" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Year filter" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Year 2025" }));

    await waitFor(() => {
      expect(filteredSummaryRequested).toBe(true);
    });

    expect(screen.queryByText("Loading Full Picture data...")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Tickets in scope" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Tickets in scope" })).toHaveTextContent("1");

    deferredSummary.resolve(createFetchResponse(createSummaryPayload()));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/full-picture/dashboard/summary?years=2026%2C2025&months=2026-05&china_scopes=China&projects=IDCEVO&phases=03-In+Analysis%2C04-In+Progress",
      );
    });
  });
});