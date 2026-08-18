import { describe, expect, it, vi } from "vitest";

import {
  normalizePreproductionSmokeConfig,
  PreproductionSmokeError,
  runPreproductionSmoke,
} from "../../../server/preproductionSmoke.mjs";
import { parsePreproductionSmokeArgs } from "../../../scripts/preproductionSmoke.mjs";

const baseConfig = {
  schemaVersion: "1.0",
  baseUrl: "https://preprod.example.test",
  timeoutMs: 5_000,
  threadId: "shared-smoke-thread",
  actors: [
    {
      label: "scope-a",
      tokenFile: "/run/secrets/smoke-a",
      aggregateQuery: "scope a aggregate",
      continuationQuery: "scope a records",
      requiredValues: ["TEAM_A"],
      forbiddenValues: ["TEAM_B"],
    },
    {
      label: "scope-b",
      tokenFile: "/run/secrets/smoke-b",
      aggregateQuery: "scope b aggregate",
      continuationQuery: "scope b records",
      requiredValues: ["TEAM_B"],
      forbiddenValues: ["TEAM_A"],
    },
  ],
};

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(event: unknown) {
  return new Response(`data: ${JSON.stringify({ type: "agent-runtime-event", event })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function createFetch({ sameAnalysisRef = false, testcase = false } = {}) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const authorization = String((init.headers as Record<string, string> | undefined)?.authorization || "");
    if (url.pathname === "/health") return jsonResponse(200, { ok: true });
    if (url.pathname === "/api/create-testcase") {
      if (!testcase) return jsonResponse(404, {});
      return jsonResponse(200, {
        success: true,
        result: { proposalCapability: "v1.signed.capability", proposalDigest: "proposal-digest" },
      });
    }
    if (url.pathname === "/api/create-testcase/commit") {
      if (!testcase) return jsonResponse(404, {});
      return jsonResponse(200, { success: true, test_id: "T-42", idempotentReplay: false });
    }
    if (url.pathname !== "/api/ai/chat") return jsonResponse(404, {});
    if (!authorization) return jsonResponse(401, { success: false, error: "AUTHENTICATED_ACTOR_REQUIRED" });
    if (authorization.includes("invalid-preproduction")) return jsonResponse(401, { success: false, error: "AUTHENTICATED_ACTOR_REQUIRED" });

    const body = JSON.parse(String(init.body || "{}"));
    const actor = authorization === "Bearer token-a" ? "a" : "b";
    const continuation = String(body.messages?.[0]?.content || "").includes("records");
    const analysisRef = sameAnalysisRef ? "shared-ref" : `analysis-${actor}`;
    return sseResponse({
      type: "analysis-result",
      analysisRef,
      sourceRevisionId: `snapshot-${actor}`,
      rows: [{ team: actor === "a" ? "TEAM_A" : "TEAM_B" }],
      metrics: continuation ? {} : { "defect.count": 1 },
    });
  });
}

const readFileSync = (file: string) => file.endsWith("smoke-a") ? "token-a\n" : "token-b\n";

describe("pre-production live smoke gate", () => {
  it("proves auth boundaries, actor isolation, RLS markers and fixed-snapshot continuation", async () => {
    const fetchImpl = createFetch();
    const result = await runPreproductionSmoke(baseConfig, {
      fetchImpl,
      readFileSync,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "passed",
      boundary: { health: "pass", unauthenticated: "pass", invalidToken: "pass" },
      actorIsolation: "pass",
      fixedSnapshotContinuation: "pass",
      actors: [
        {
          label: "scope-a",
          requiredValueAssertions: { aggregate: 1, continuation: 0 },
          forbiddenValueAssertions: { aggregate: 1, continuation: 1 },
        },
        {
          label: "scope-b",
          requiredValueAssertions: { aggregate: 1, continuation: 0 },
          forbiddenValueAssertions: { aggregate: 1, continuation: 1 },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("token-a");
    expect(JSON.stringify(result)).not.toContain("TEAM_A");
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    const actorCalls = fetchImpl.mock.calls.slice(3);
    expect(actorCalls.every(([, request]) => JSON.parse(String(request?.body)).threadId === "shared-smoke-thread")).toBe(true);
  });

  it("fails when two actors receive the same actor-scoped analysis reference", async () => {
    await expect(runPreproductionSmoke(baseConfig, {
      fetchImpl: createFetch({ sameAnalysisRef: true }),
      readFileSync,
    })).rejects.toMatchObject<PreproductionSmokeError>({
      code: "PREPRODUCTION_SMOKE_CROSS_ACTOR_ANALYSIS_REF_REUSED",
    });
  });

  it("rejects embedded credentials and insecure remote origins", () => {
    expect(() => normalizePreproductionSmokeConfig({ ...baseConfig, access_token: "secret" })).toThrow(
      "PREPRODUCTION_SMOKE_SECRET_IN_CONFIG:access_token",
    );
    expect(() => normalizePreproductionSmokeConfig({ ...baseConfig, baseUrl: "http://preprod.example.test" })).toThrow(
      "PREPRODUCTION_SMOKE_BASE_URL_INVALID",
    );
  });

  it("requires both config confirmation and an explicit CLI flag before testcase mutation", async () => {
    const config = {
      ...baseConfig,
      testcaseCanary: {
        mode: "commit",
        actorLabel: "scope-a",
        defectId: "D-7",
        ownerWorkspaceUserId: "U-3",
        featureId: "F-2",
        confirmation: "CREATE_ONE_TESTCASE:D-7",
      },
    };
    await expect(runPreproductionSmoke(config, {
      fetchImpl: createFetch({ testcase: true }),
      readFileSync,
    })).rejects.toMatchObject<PreproductionSmokeError>({ code: "PREPRODUCTION_SMOKE_TESTCASE_MUTATION_NOT_CONFIRMED" });

    const fetchImpl = createFetch({ testcase: true });
    const result = await runPreproductionSmoke(config, {
      fetchImpl,
      readFileSync,
      allowTestcaseMutation: true,
    });
    expect(result.testcase).toEqual({ mode: "commit", testId: "T-42", idempotentReplay: false });
    const commitCall = fetchImpl.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith("/commit"));
    const submitted = JSON.parse(String(commitCall?.[1]?.body));
    expect(submitted).toEqual({
      proposal_capability: "v1.signed.capability",
      feature_id: "F-2",
      owner_workspace_user_id: "U-3",
    });
    expect(submitted).not.toHaveProperty("test_case_data");
  });

  it("parses the opt-in mutation flag without accepting unknown arguments", () => {
    expect(parsePreproductionSmokeArgs([
      "--config", "smoke.json", "--output=artifact.json", "--allow-testcase-mutation",
    ])).toEqual({ config: "smoke.json", output: "artifact.json", allowTestcaseMutation: true });
    expect(() => parsePreproductionSmokeArgs(["--unknown"])).toThrow("PREPRODUCTION_SMOKE_ARGUMENT_UNKNOWN");
  });
});
