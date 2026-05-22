import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MainDashboard from "@/components/dashboard/pages/MainDashboard";

function createDashboardPayload() {
  return {
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
    filters: {
      years: ["2025", "2026"],
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
    ticket_rows: [
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
        project: "G68",
        assigned_ecu: "ECU-A",
        aida: "Digital",
        solution_cluster: "Integration",
        pu: "PU1",
        market: "CN",
        lead_model: "LM1",
      },
    ],
  };
}

function createFetchResponse(payload = createDashboardPayload()) {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
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

describe("MainDashboard real data loading", () => {
  it("loads data through the real query path and replaces the loading state", async () => {
    const response = createDeferred<Response>();
    vi.mocked(fetch).mockReturnValue(response.promise);

    renderMainDashboard(createQueryClient());

    expect(screen.getByText("Loading Full Picture data...")).toBeInTheDocument();

    response.resolve(createFetchResponse());

    expect(await screen.findByText("Solution Outcome")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/full-picture/dashboard");
    expect(screen.getByRole("article", { name: "Tickets in scope" })).toHaveTextContent("1");
  });

  it("shows a fatal alert when the initial dashboard load fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Network down"));

    renderMainDashboard(createQueryClient());

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent("Unable to load Full Picture data.");
    expect(alert).toHaveTextContent("Network down");
  });

  it("keeps cached data visible when a refresh fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(createFetchResponse())
      .mockRejectedValueOnce(new TypeError("Refresh failed"));

    const queryClient = createQueryClient();
    renderMainDashboard(queryClient);

    expect(await screen.findByText("Solution Outcome")).toBeInTheDocument();

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["main-dashboard"] });
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
});