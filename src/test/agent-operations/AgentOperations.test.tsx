import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

import AgentOperations from "@/components/dashboard/pages/AgentOperations";
import DashboardSidebar from "@/components/dashboard/DashboardSidebar";

describe("AgentOperations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    getSessionMock.mockReset();
  });

  it("renders sanitized operational metrics with the current session bearer", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "operator-session" } }, error: null });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
        totalRuns: 3,
        byOutcome: { completed: 2, denied: 1 },
        byEvidenceStatus: { pass: 2, blocked: 1 },
        latency: { p50Ms: 120, p95Ms: 300 },
        tokenUsage: { inputTokens: 120, outputTokens: 50, totalTokens: 170 },
        citationValidation: { pass: 2, blocked: 1 },
        topFailureCodes: [{ code: "TOOL_ACCESS_DENIED", count: 1 }],
        recoveryOutcomes: { recovered: 1 },
          runs: [{ runRef: "run-0123456789abcdef", actorScopeHash: "scope-a", intent: "metric_query", outcome: "completed", evidenceStatus: "pass", toolNames: ["query_analytics"] }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          run: { runRef: "run-0123456789abcdef", actorScopeHash: "scope-a", intent: "metric_query", outcome: "completed", evidenceStatus: "pass", toolNames: ["query_analytics"] },
          timeline: [{ type: "agent-stream-completed", citationValidation: "pass" }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentOperations />);

    expect(await screen.findByText("3")).toBeInTheDocument();
  expect(screen.getByText("Tokens")).toBeInTheDocument();
  expect(screen.getByText("170")).toBeInTheDocument();
    expect(screen.getByText("TOOL_ACCESS_DENIED")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/agent-operations/summary", expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer operator-session" }),
      }));
    });
    fireEvent.click(screen.getByRole("button", { name: "run-0123456789abcdef" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/agent-operations/runs/run-0123456789abcdef", expect.any(Object));
    });
    expect(await screen.findByText("Run timeline: run-0123456789abcdef")).toBeInTheDocument();
  });

  it("shows an access-denied state without exposing audit content", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ success: false, error: "AGENT_OPERATIONS_ACCESS_DENIED" }),
    }));

    render(<AgentOperations />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
    expect(screen.queryByText("run-1")).not.toBeInTheDocument();
  });

  it("adds Agent Operations to dashboard navigation", () => {
    render(<DashboardSidebar active="agent-operations" onNavigate={() => {}} />);

    expect(screen.getByRole("button", { name: "Agent Operations" })).toBeInTheDocument();
  });
});