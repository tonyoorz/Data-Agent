import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createSessionEventLog,
  validateSessionEvent,
} from "../../../../server/agentRuntime/sessionEventLog.mjs";
import { createTokenBudgetGuard } from "../../../../server/agentRuntime/tokenBudgetGuard.mjs";
import { createApprovalFlow } from "../../../../server/agentRuntime/approvalFlow.mjs";
import { createFeedbackLoop, createSemanticCache, similarity } from "../../../../server/agentRuntime/feedbackAndCache.mjs";
import { createSubagentFanout } from "../../../../server/agentRuntime/subagentFanout.mjs";
import { buildDataHealth } from "../../../../server/agentRuntime/dataQualityNote.mjs";
import { buildDynamicPlanningContext, withDataQualityFootnote } from "../../../../server/agentRuntime/dynamicContext.mjs";

const NOW = () => new Date("2026-08-15T03:00:00.000Z");

describe("session event log", () => {
  it("appends, replays and derives model-visible messages", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "session-events-"));
    const log = createSessionEventLog({ rootDir, now: NOW });

    await log.append({ type: "session/start", sessionId: "s1", payload: { actorId: "u1" } });
    await log.append({ type: "user/message", sessionId: "s1", payload: { content: "上月缺陷趋势" } });
    await log.append({ type: "tool/call", sessionId: "s1", payload: { id: "t1", name: "query_analytics", arguments: "{}" } });
    await log.append({ type: "tool/result", sessionId: "s1", payload: { id: "t1", resultText: "5 rows", ok: true } });
    await log.append({ type: "agent/response", sessionId: "s1", payload: { content: "趋势上升" } });

    const derived = await log.replay("s1", log.deriveMessagesReducer);
    expect(derived.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(derived.messages[0].content).toBe("上月缺陷趋势");
    expect(derived.messages[2].content).toBe("5 rows");

    const metrics = await log.metrics("s1");
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.toolErrors).toBe(0);
    expect(metrics.tokens.total).toBe(0);
  });

  it("forks a session at a boundary with parent linkage", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "session-events-"));
    const log = createSessionEventLog({ rootDir, now: NOW });

    await log.append({ type: "session/start", sessionId: "parent", payload: {} });
    await log.append({ type: "user/message", sessionId: "parent", payload: { content: "q1" } });
    const second = await log.append({ type: "user/message", sessionId: "parent", payload: { content: "q2" } });
    await log.append({ type: "user/message", sessionId: "parent", payload: { content: "q3" } });

    const forked = await log.fork("parent", second.seq, "child");
    expect(forked.copied).toBe(2);

    const childEvents = await log.read("child");
    expect(childEvents[0].type).toBe("session/start");
    expect(childEvents[0].payload.forkedFrom).toBe("parent");
    expect(childEvents.filter((event) => event.type === "user/message").map((event) => event.payload.content)).toEqual(["q1", "q2"]);
  });

  it("rejects invalid events", () => {
    expect(validateSessionEvent({ type: "nope" })).toContain("unknown session event type");
    expect(validateSessionEvent({ type: "user/message" })).toContain("sessionId is required");
  });
});

describe("token budget guard", () => {
  it("tracks usage and blocks steps over budget", () => {
    const guard = createTokenBudgetGuard({ env: { VIZION_TOKEN_SESSION_BUDGET: "1000" }, now: NOW });
    expect(guard.canStep()).toBe(true);

    guard.recordRequest({ input: 600, output: 100 });
    expect(guard.canStep()).toBe(true);

    guard.recordRequest({ input: 400, output: 100 });
    expect(guard.canStep()).toBe(false);
    expect(guard.snapshot().exceeded).toBe(true);

    const note = guard.budgetNote();
    expect(note.reason).toBe("SESSION_BUDGET_EXCEEDED");
    expect(note.spent).toBe(1200);
  });

  it("caps tool steps independently", () => {
    const guard = createTokenBudgetGuard({ env: { VIZION_TOOL_STEP_BUDGET: "2" }, now: NOW });
    guard.recordToolStep();
    expect(guard.canToolStep()).toBe(true);
    guard.recordToolStep();
    expect(guard.canToolStep()).toBe(false);
  });
});

describe("approval flow", () => {
  it("requests, decides and resumes with handoff state", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "session-events-"));
    const log = createSessionEventLog({ rootDir, now: NOW });
    const flow = createApprovalFlow({ eventLog: log, now: NOW });

    const request = await flow.request({
      sessionId: "s1",
      kind: "dry_run",
      summary: "create testcase draft",
      toolCall: { name: "testcase_proposal", arguments: { defectId: 2774806 } },
      handoffState: { plannedToolCalls: [{ name: "finalize" }] },
    });
    expect(request.approvalId).toMatch(/^apr_/);
    expect(flow.listPending("s1")).toHaveLength(1);

    const outcome = await flow.decide({ approvalId: request.approvalId, decision: "approved" });
    expect(outcome.decision).toBe("approved");
    expect(outcome.handoffState.plannedToolCalls).toHaveLength(1);

    const events = await log.read("s1");
    expect(events.map((event) => event.type)).toEqual(["approval/request", "approval/decision"]);
    expect(flow.listPending()).toHaveLength(0);
  });

  it("expires stale approvals automatically", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "session-events-"));
    const log = createSessionEventLog({ rootDir, now: NOW });
    let clock = new Date("2026-08-15T03:00:00.000Z");
    const flow = createApprovalFlow({ eventLog: log, now: () => clock, ttlMs: 1000 });

    await flow.request({ sessionId: "s1", toolCall: { name: "x", arguments: {} } });
    clock = new Date("2026-08-15T03:00:05.000Z");
    const expired = await flow.expireStale();
    expect(expired).toHaveLength(1);
    expect(flow.listPending()).toHaveLength(0);
  });
});

describe("feedback loop and semantic cache", () => {
  it("derives policy adjustments from thumbs", async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), "feedback-"));
    const loop = createFeedbackLoop({ storeDir, now: NOW });

    await loop.recordThumb({ sessionId: "s1", queryText: "高频缺陷有哪些", intent: "high_frequency", toolNames: ["query_analytics"], thumb: "down" });
    await loop.recordThumb({ sessionId: "s2", queryText: "高频缺陷 top3", intent: "high_frequency", toolNames: ["query_analytics"], thumb: "down" });
    await loop.recordThumb({ sessionId: "s3", queryText: "覆盖率状态", intent: "coverage_query", toolNames: ["query_testing_coverage_project_status"], thumb: "up" });

    const adjustments = await loop.derivePolicyAdjustments();
    const demoted = adjustments.find((item) => item.action === "demote");
    expect(demoted?.intent).toBe("high_frequency");

    const negatives = await loop.findSimilarNegatives("高频缺陷是什么");
    expect(negatives.length).toBeGreaterThan(0);
  });

  it("caches governed results by fingerprint and similarity", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "semcache-"));
    const cache = createSemanticCache({ cacheDir, now: NOW });

    await cache.set({ planFingerprint: "fp_9a3c", queryText: "上个月 ISTEP Critical 缺陷趋势", intent: "metric_query", result: { rows: 5, analysisRef: "ref_8f21" } });

    const exact = await cache.get("fp_9a3c");
    expect(exact.analysisRef).toBe("ref_8f21");
    expect(exact._cache.via).toBe("exact");

    const miss = await cache.get("fp_other");
    expect(miss).toBeNull();

    const similar = await cache.getSimilar("上个月 ISTEP Critical 缺陷的趋势", { intent: "metric_query" });
    expect(similar?.rows).toBe(5);
    expect(similar._cache.via).toContain("similar");
  });

  it("similarity handles CJK bigrams", () => {
    expect(similarity("上个月缺陷趋势", "上个月缺陷趋势")).toBe(1);
    expect(similarity("上个月缺陷趋势", "覆盖率状态")).toBeLessThan(0.3);
  });
});

describe("subagent fanout", () => {
  it("runs branches in parallel and isolates failures", async () => {
    const fanout = createSubagentFanout({ now: NOW });
    const result = await fanout.run([
      { name: "trend", run: async () => ({ value: 42 }) },
      { name: "coverage", run: async () => { throw new Error("backend down"); } },
      { name: "rank", run: async () => ({ top: "BCM" }) },
    ]);

    expect(result.ok.map((item) => item.branch).sort()).toEqual(["rank", "trend"]);
    expect(result.failed[0].branch).toBe("coverage");
    expect(result.failed[0].reason).toContain("backend down");

    const evidence = fanout.composeEvidence(result);
    expect(evidence).toContain("## evidence:trend");
    expect(evidence).toContain("## evidence:coverage (FAILED");
  });

  it("enforces branch budget", async () => {
    const guard = createTokenBudgetGuard({ env: { VIZION_TOKEN_SESSION_BUDGET: "1" }, now: NOW });
    const fanout = createSubagentFanout({ budgetGuard: guard, now: NOW });
    const result = await fanout.run([{ name: "x", run: async () => ({}) }]);
    expect(result.failed[0].reason).toContain("BRANCH_BUDGET_EXCEEDED");
  });
});

describe("data quality notes", () => {
  it("flags stale and partial datasets", () => {
    const health = buildDataHealth({
      datasets: [
        { name: "defects", lastRefreshedAt: "2026-08-15T02:00:00.000Z", expectedFrequencyHours: 4, completeness: 0.99 },
        { name: "manual_runs", lastRefreshedAt: "2026-08-14T18:00:00.000Z", expectedFrequencyHours: 4, completeness: 0.9 },
      ],
      now: NOW,
    });
    expect(health.ok).toBe(false);
    expect(health.notes.join(" ")).toContain("manual_runs");
    expect(health.entries[0].severity).toBe("ok");
    expect(health.entries[1].severity).not.toBe("ok");
  });
});

describe("dynamic planning context", () => {
  it("assembles only selected toolset rules", () => {
    const context = buildDynamicPlanningContext({
      intent: "metric_query",
      toolNames: ["query_analytics", "diagnose_analytics_empty"],
      policyHints: ["semantic_first"],
      runtimeDate: "2026-08-15",
    });
    expect(context).toContain("query_analytics");
    expect(context).toContain("diagnose_analytics_empty");
    expect(context).not.toContain("search_duplicates:");
    expect(context).toContain("semantic_first");
    expect(context).toContain("2026-08-15");
  });

  it("appends data quality footnote to answers", () => {
    const answer = withDataQualityFootnote("趋势上升", { notes: ["manual_runs: 完整度 90%"] });
    expect(answer).toContain("趋势上升");
    expect(answer).toContain("⚠️ 数据说明");
    expect(answer).toContain("manual_runs");
  });
});
