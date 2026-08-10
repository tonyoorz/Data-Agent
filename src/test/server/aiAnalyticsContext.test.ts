import { describe, expect, it, vi } from "vitest";

import { resolveAiAnalyticsContext } from "../../../server/aiAnalyticsContext.mjs";
import { createOntologyRegistry } from "../../../server/ontology/registry.mjs";

describe("resolveAiAnalyticsContext", () => {
  it("builds compact business context for analytics questions", async () => {
    const resolved = await resolveAiAnalyticsContext({
      messages: [{ role: "user", content: "Speech 最近测试覆盖率和缺陷 outcome 怎么样？" }],
    });

    expect(resolved.contextText).toContain("# Analytics business context");
    expect(resolved.contextText).toContain("Testing Coverage");
    expect(resolved.contextText).toContain("Resolved Forward");
    expect(resolved.contextText).toContain("octane_manual_runs");
  });

  it("resolves follow-up DTSV opened questions to a real June summary query", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        overview: { ticket_count: 12 },
        snapshot_version: "snapshot-20260707-1",
      }),
    });

    const resolved = await resolveAiAnalyticsContext({
      messages: [
        { role: "user", content: "DTSV 6月份提了多少bug" },
        { role: "assistant", content: "你问的是 opened 还是 resolved？" },
        { role: "user", content: "DTSV， opened" },
      ],
      analyticsFetch,
      now: new Date("2026-07-07T00:00:00Z"),
    });

    expect(analyticsFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3003/api/full-picture/dashboard/summary?years=2026&problem_finder_teams=DTSV_China&creation_time_start=2026-06-01&creation_time_end=2026-06-30",
    );
    expect(resolved.contextText).toContain("DTSV maps to problem_finder_team=DTSV_China");
    expect(resolved.contextText).toContain("opened/created means octane_defects.creation_time");
    expect(resolved.contextText).toContain("Result: 12 defects");
    expect(resolved.contextText).toContain("Do not invent modules such as ai-chat, user-auth, payment, or data-pipeline");
    expect(resolved.skipDefectContext).toBe(true);
  });

  it("stays silent for empty questions", async () => {
    expect((await resolveAiAnalyticsContext({ messages: [] })).contextText).toBe("");
  });

  it("adds governed ontology interpretation when registry and actor are provided", async () => {
    const resolved = await resolveAiAnalyticsContext({
      messages: [{ role: "user", content: "最近一周 DTSV 新增缺陷按 ECU Top 5" }],
      now: new Date("2026-07-15T04:00:00.000Z"),
      actor: { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } },
      ontologyRegistry: createOntologyRegistry(),
    });

    expect(resolved.contextText).toContain("# Governed Ontology interpretation");
    expect(resolved.contextText).toContain("Intent: rank");
    expect(resolved.contextText).toContain("defect.created_count");
    expect(resolved.contextText).toContain("Plan status: valid");
    expect(resolved.contextText).toContain("# Governed analysis plan");
    expect(resolved.analysisPlan).toMatchObject({ operation: "ranked_comparison", visualization: "bar" });
    expect(resolved.contextText).toContain(`Analysis plan: ${resolved.analysisPlan.analysisPlanId}`);
    expect(resolved.contextText).toContain(`Ontology version: ${resolved.analysisPlan.ontologyVersion}`);
    expect(resolved.contextText).toContain(`Source plan fingerprint: ${resolved.analysisPlan.sourcePlanFingerprint}`);
    expect(resolved.contextText).toContain("BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time");
    expect(resolved.shadowObservation).toMatchObject({
      status: "completed",
      tools: ["query_semantic_metrics"],
      analysisPlan: expect.objectContaining({
        analysisPlanId: resolved.analysisPlan.analysisPlanId,
        sourcePlanId: resolved.analysisPlan.sourcePlanId,
        ontologyVersion: resolved.analysisPlan.ontologyVersion,
        schemaFingerprint: resolved.analysisPlan.schemaFingerprint,
        sourcePlanFingerprint: resolved.analysisPlan.sourcePlanFingerprint,
        operation: "ranked_comparison",
        visualization: "bar",
        maxRows: 5,
        guardrails: expect.arrayContaining(["READ_ONLY_SOURCE_PLAN", "NO_ARBITRARY_CODE", "NO_ARBITRARY_SQL"]),
        ruleEffects: [expect.objectContaining({ code: "BUSINESS_RULE_REQUIRE:business.defect_created_count.creation_time" })],
      }),
    });
  });

  it("passes an LLM semantic candidate into the ontology resolver", async () => {
    const requestSemanticCandidate = vi.fn().mockResolvedValue({
      intent: "aggregate",
      entityIds: ["testing.test_run"],
      metricIds: ["testing.run_count"],
      dimensionIds: [],
    });

    const resolved = await resolveAiAnalyticsContext({
      messages: [{ role: "user", content: "各楼层工位利用率" }],
      now: new Date("2026-07-15T04:00:00.000Z"),
      actor: { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } },
      ontologyRegistry: createOntologyRegistry(),
      requestSemanticCandidate,
    });

    expect(requestSemanticCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ query: "各楼层工位利用率", registry: expect.objectContaining({ version: "v1" }) }),
    );
    expect(resolved.contextText).toContain("testing.run_count");
    expect(resolved.contextText).not.toContain("defect.count@1.0.0");
  });

  it("keeps an ungrounded full-catalog guess behind clarification", async () => {
    const resolved = await resolveAiAnalyticsContext({
      messages: [{ role: "user", content: "各楼层工位利用率" }],
      now: new Date("2026-07-15T04:00:00.000Z"),
      actor: { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } },
      ontologyRegistry: createOntologyRegistry(),
      requestSemanticCandidate: vi.fn().mockResolvedValue({
        intent: "aggregate",
        entityIds: ["testing.test_run"],
        metricIds: ["testing.run_count"],
        dimensionIds: [],
        catalogSelection: { mode: "full_catalog", matchedTermIds: [] },
      }),
    });

    expect(resolved.queryPlan).toMatchObject({
      status: "needs_clarification",
      steps: [],
      violations: expect.arrayContaining(["METRIC_REQUIRED"]),
    });
    expect(resolved.contextText).not.toContain("testing.run_count@1.0.0");
  });
});
