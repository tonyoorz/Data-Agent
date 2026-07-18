import { describe, expect, it, vi } from "vitest";

import { resolveAiAnalyticsContext } from "../../../server/aiAnalyticsContext.mjs";
import { createOntologyRegistry } from "../../../server/ontology/registry.mjs";

const governedActor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"], projectIds: ["SP25"] } };

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

  it("does not expose analytics provider errors in model context", async () => {
    const resolved = await resolveAiAnalyticsContext({
      messages: [{ role: "user", content: "2026 年 6 月 DTSV 创建了多少缺陷？" }],
      analyticsFetch: vi.fn().mockRejectedValue(new Error("TOP SECRET PROVIDER DETAIL")),
      now: new Date("2026-07-07T00:00:00Z"),
    });

    expect(resolved.contextText).toContain("ANALYTICS_QUERY_FAILED");
    expect(resolved.contextText).not.toContain("TOP SECRET");
  });

  it("injects the same governed semantic, scope, and tool signatures used by shadow Runtime", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ overview: { ticket_count: 12 } }) });
    const resolved = await resolveAiAnalyticsContext({
      messages: [{ role: "user", content: "2026 年 6 月 DTSV 创建了多少缺陷？" }],
      analyticsFetch,
      now: new Date("2026-07-07T00:00:00Z"),
      actor: governedActor,
      ontologyRegistry: createOntologyRegistry(),
    });

    expect(resolved.contextText).toContain("# Governed Ontology interpretation");
    expect(resolved.contextText).toContain("defect.created_count");
    expect(resolved.contextText).toContain("policy:product.project:in:SP25");
    expect(resolved.shadowObservation).toMatchObject({
      semanticSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
      scopeSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(String(analyticsFetch.mock.calls[0][0])).toContain("projects=SP25");
  });
});
