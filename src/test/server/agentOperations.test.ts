import { describe, expect, it, vi } from "vitest";

import {
  AGENT_OPERATIONS_READ_POLICY,
  resolveAgentOperationsResponse,
} from "../../../server/agentOperations.mjs";

describe("agent operations endpoint policy", () => {
  it("allows only a server-resolved operations reader to load summaries", async () => {
    const readOperations = vi.fn(async () => ({ totalRuns: 2, runs: [] }));
    const response = await resolveAgentOperationsResponse({
      request: { headers: { authorization: "Bearer test" } },
      operation: "summary",
      resolveActor: async () => ({
        actorId: "operator",
        scopeHash: "scope-operator",
        scopes: { rowPolicyIds: [AGENT_OPERATIONS_READ_POLICY] },
      }),
      readOperations,
    });

    expect(response).toEqual({ statusCode: 200, payload: { totalRuns: 2, runs: [] } });
    expect(readOperations).toHaveBeenCalledWith({ operation: "summary", runId: "" });
  });

  it("rejects an authenticated actor without the dedicated operations policy", async () => {
    const readOperations = vi.fn();
    const response = await resolveAgentOperationsResponse({
      request: { headers: { authorization: "Bearer test" } },
      operation: "summary",
      resolveActor: async () => ({ actorId: "reader", scopeHash: "scope-reader", scopes: { rowPolicyIds: [] } }),
      readOperations,
    });

    expect(response).toEqual({
      statusCode: 403,
      payload: { success: false, error: "AGENT_OPERATIONS_ACCESS_DENIED" },
    });
    expect(readOperations).not.toHaveBeenCalled();
  });
});