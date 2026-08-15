import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createSessionEventLog } from "../../../../server/agentRuntime/sessionEventLog.mjs";
import {
  createEvalMetricsService,
  deriveEvalMetrics,
} from "../../../../server/agentRuntime/evalMetrics.mjs";

const NOW = () => new Date("2026-08-15T03:00:00.000Z");

function event(type, payload, { sessionId = "s1", recordedAt = "2026-08-15T02:00:00.000Z", seq = 1 } = {}) {
  return { type, sessionId, payload, recordedAt, seq };
}

function successfulTurnEvents({ runId = "run_1", recordedAt = "2026-08-15T02:00:00.000Z", sessionId = "s1", tools = 1, toolErrors = 0, stoppedReason = "no_tool_calls" } = {}) {
  const events = [
    event("turn/start", { runId, queryText: "q" }, { sessionId, recordedAt }),
    event("agent/request", { runId, tokens: { input: 100, output: 20, total: 120 } }, { sessionId, recordedAt }),
  ];
  for (let index = 0; index < tools; index += 1) {
    events.push(event("tool/call", { id: `t${index + 1}`, name: "query_analytics", arguments: "{}" }, { sessionId, recordedAt }));
    events.push(event("tool/result", { id: `t${index + 1}`, ok: index < toolErrors ? false : true, resultText: "rows" }, { sessionId, recordedAt }));
  }
  events.push(
    event("agent/response", {
      runId,
      tokenUsage: { input: 120, output: 30, total: 150 },
      answerValidation: { valid: true },
    }, { sessionId, recordedAt }),
    event("turn/end", { runId, stoppedReason }, { sessionId, recordedAt }),
  );
  return events;
}

describe("deriveEvalMetrics (pure per-session derivation)", () => {
  it("returns zeroed metrics for empty events", () => {
    const metrics = deriveEvalMetrics([], { now: NOW });
    expect(metrics.turns).toBe(0);
    expect(metrics.completedTurns).toBe(0);
    expect(metrics.taskSuccessRate).toBe(0);
    expect(metrics.clarificationRate).toBe(0);
    expect(metrics.toolErrorRate).toBe(0);
    expect(metrics.avgToolCallsPerTurn).toBe(0);
    expect(metrics.tokenUsageTotal).toEqual({ input: 0, output: 0, total: 0 });
    expect(metrics.answerValidationPassRate).toBe(0);
  });

  it("counts a single fully successful turn", () => {
    const metrics = deriveEvalMetrics(successfulTurnEvents(), { now: NOW });
    expect(metrics.turns).toBe(1);
    expect(metrics.completedTurns).toBe(1);
    expect(metrics.successfulTurns).toBe(1);
    expect(metrics.taskSuccessRate).toBe(1);
    expect(metrics.clarificationRate).toBe(0);
    expect(metrics.toolErrorRate).toBe(0);
    expect(metrics.avgToolCallsPerTurn).toBe(1);
    expect(metrics.tokenUsageTotal).toEqual({ input: 120, output: 30, total: 150 });
    expect(metrics.answerValidationPassRate).toBe(1);
  });

  it("counts a clarification turn when ask_clarification is called", () => {
    const events = [
      event("turn/start", { runId: "r1", queryText: "模糊问题" }),
      event("tool/call", { id: "t1", name: "ask_clarification", arguments: "{}" }),
      event("tool/result", { id: "t1", ok: true, resultText: "请补充" }),
      event("agent/response", { runId: "r1", tokenUsage: null, answerValidation: null }),
      event("turn/end", { runId: "r1", stoppedReason: "no_tool_calls" }),
    ];
    const metrics = deriveEvalMetrics(events, { now: NOW });
    expect(metrics.clarificationTurns).toBe(1);
    expect(metrics.clarificationRate).toBe(1);
    expect(metrics.taskSuccessRate).toBe(1);
  });

  it("computes tool error rate over all tool results", () => {
    const events = successfulTurnEvents({ tools: 3, toolErrors: 1 });
    const metrics = deriveEvalMetrics(events, { now: NOW });
    expect(metrics.toolResults).toBe(3);
    expect(metrics.toolErrors).toBe(1);
    expect(metrics.toolErrorRate).toBeCloseTo(0.3333, 4);
  });

  it("treats budget_exceeded turns as completed failures (in denominator)", () => {
    const events = [
      ...successfulTurnEvents({ runId: "r_ok" }),
      ...successfulTurnEvents({ runId: "r_budget", stoppedReason: "budget_exceeded" }),
    ];
    const metrics = deriveEvalMetrics(events, { now: NOW });
    expect(metrics.completedTurns).toBe(2);
    expect(metrics.successfulTurns).toBe(1);
    expect(metrics.failedTurns).toBe(1);
    expect(metrics.evaluableTurns).toBe(2);
    expect(metrics.taskSuccessRate).toBe(0.5);
  });

  it("excludes approval_pending from both success numerator and denominator, reports own rate", () => {
    const events = [
      ...successfulTurnEvents({ runId: "r_ok" }),
      ...successfulTurnEvents({ runId: "r_pending", stoppedReason: "approval_pending" }),
    ];
    const metrics = deriveEvalMetrics(events, { now: NOW });
    expect(metrics.completedTurns).toBe(2);
    expect(metrics.approvalPendingTurns).toBe(1);
    expect(metrics.evaluableTurns).toBe(1);
    expect(metrics.successfulTurns).toBe(1);
    expect(metrics.failedTurns).toBe(0);
    expect(metrics.taskSuccessRate).toBe(1);
    expect(metrics.approvalPendingRate).toBe(0.5);
  });

  it("does not count a turn without turn/end as completed and records runtime errors", () => {
    const events = [
      event("turn/start", { runId: "r_crash", queryText: "q" }),
      event("tool/call", { id: "t1", name: "query_analytics", arguments: "{}" }),
      event("tool/result", { id: "t1", ok: false, resultText: "" }),
      event("error/runtime", { runId: "r_crash", message: "boom" }),
    ];
    const metrics = deriveEvalMetrics(events, { now: NOW });
    expect(metrics.turns).toBe(1);
    expect(metrics.completedTurns).toBe(0);
    expect(metrics.taskSuccessRate).toBe(0);
    expect(metrics.toolErrorRate).toBe(1);
    expect(metrics.runtimeErrors).toBe(1);
  });

  it("requires an agent/response on the same runId for success", () => {
    const events = [
      event("turn/start", { runId: "r1", queryText: "q" }),
      event("tool/call", { id: "t1", name: "query_analytics", arguments: "{}" }),
      event("tool/result", { id: "t1", ok: true, resultText: "rows" }),
      event("turn/end", { runId: "r1", stoppedReason: "no_tool_calls" }),
      // response belongs to a different run — must not leak across runs
      event("agent/response", { runId: "r_other", tokenUsage: null, answerValidation: null }),
    ];
    const metrics = deriveEvalMetrics(events, { now: NOW });
    expect(metrics.completedTurns).toBe(1);
    expect(metrics.successfulTurns).toBe(0);
    expect(metrics.taskSuccessRate).toBe(0);
  });

  it("handles the real runtime ordering where turn/end precedes agent/response", () => {
    const events = [
      event("turn/start", { runId: "r1", queryText: "q" }),
      event("tool/call", { id: "t1", name: "query_analytics", arguments: "{}" }), // no runId, like the runtime
      event("tool/result", { id: "t1", ok: true, resultText: "rows" }),
      event("turn/end", { runId: "r1", stoppedReason: "no_tool_calls" }),
      event("agent/response", { runId: "r1", tokenUsage: { input: 10, output: 5, total: 15 }, answerValidation: { valid: true } }),
    ];
    const metrics = deriveEvalMetrics(events, { now: NOW });
    expect(metrics.completedTurns).toBe(1);
    expect(metrics.successfulTurns).toBe(1);
    expect(metrics.taskSuccessRate).toBe(1);
    expect(metrics.tokenUsageTotal).toEqual({ input: 10, output: 5, total: 15 });
  });

  it("passes through answerValidation failures", () => {
    const events = [
      ...successfulTurnEvents({ runId: "r_valid" }),
      ...successfulTurnEvents({ runId: "r_invalid" }).map((item, index) =>
        item.type === "agent/response"
          ? { ...item, payload: { ...item.payload, answerValidation: { valid: false } } }
          : item,
      ),
    ];
    const metrics = deriveEvalMetrics(events, { now: NOW });
    expect(metrics.answerValidations).toBe(2);
    expect(metrics.answerValidationPassed).toBe(1);
    expect(metrics.answerValidationPassRate).toBe(0.5);
  });
});

describe("createEvalMetricsService (cross-session aggregation)", () => {
  async function seedService({ sessions = [] } = {}) {
    const rootDir = await mkdtemp(path.join(tmpdir(), "eval-metrics-"));
    let current = NOW();
    const log = createSessionEventLog({ rootDir, now: () => current });
    for (const { sessionId, events } of sessions) {
      for (const item of events) {
        // append() stamps recordedAt from the log clock: advance it per event.
        current = new Date(item.recordedAt || NOW().toISOString());
        await log.append({ ...item, sessionId });
      }
    }
    return { log, service: createEvalMetricsService({ sessionEventLog: log, now: NOW }) };
  }

  it("aggregates metrics across sessions", async () => {
    const { service } = await seedService({
      sessions: [
        { sessionId: "s1", events: successfulTurnEvents({ sessionId: "s1", runId: "r1" }) },
        { sessionId: "s2", events: successfulTurnEvents({ sessionId: "s2", runId: "r2", toolErrors: 1 }) },
      ],
    });
    const report = await service.report({ windowDays: 7 });
    expect(report.aggregate.sessionsEvaluated).toBe(2);
    expect(report.aggregate.turns).toBe(2);
    expect(report.aggregate.successfulTurns).toBe(2);
    expect(report.aggregate.taskSuccessRate).toBe(1);
    expect(report.aggregate.toolErrorRate).toBe(0.5);
    expect(report.aggregate.tokenUsageTotal).toEqual({ input: 240, output: 60, total: 300 });
    expect(report.generatedAt).toBe(NOW().toISOString());
  });

  it("excludes sessions whose last activity is older than the window", async () => {
    const oldDay = "2026-07-01T00:00:00.000Z";
    const { service } = await seedService({
      sessions: [
        { sessionId: "old", events: successfulTurnEvents({ sessionId: "old", runId: "r_old", recordedAt: oldDay }) },
        { sessionId: "fresh", events: successfulTurnEvents({ sessionId: "fresh", runId: "r_fresh" }) },
      ],
    });
    const report = await service.report({ windowDays: 7 });
    expect(report.aggregate.sessionsEvaluated).toBe(1);
    expect(report.aggregate.turns).toBe(1);
    expect(report.daily).toHaveLength(7);
    expect(report.daily[6].date).toBe("2026-08-15");
    expect(report.daily[6].isToday).toBe(true);
  });

  it("buckets turns into UTC daily series and zero-fills gaps", async () => {
    const { service } = await seedService({
      sessions: [
        {
          sessionId: "s1",
          events: [
            ...successfulTurnEvents({ sessionId: "s1", runId: "r1", recordedAt: "2026-08-14T22:00:00.000Z" }),
            ...successfulTurnEvents({ sessionId: "s1", runId: "r2", recordedAt: "2026-08-15T01:00:00.000Z" }),
          ],
        },
      ],
    });
    const report = await service.report({ windowDays: 7 });
    const day14 = report.daily.find((day) => day.date === "2026-08-14");
    const day15 = report.daily.find((day) => day.date === "2026-08-15");
    const day13 = report.daily.find((day) => day.date === "2026-08-13");
    expect(day14.turns).toBe(1);
    expect(day15.turns).toBe(1);
    expect(day13.turns).toBe(0);
    expect(report.daily.reduce((sum, day) => sum + day.turns, 0)).toBe(report.aggregate.turns);
    expect(day15.taskSuccessRate).toBe(1);
  });

  it("latest() returns a compact 24h top-line", async () => {
    const { service } = await seedService({
      sessions: [{ sessionId: "s1", events: successfulTurnEvents({ sessionId: "s1", runId: "r1" }) }],
    });
    const latest = await service.latest();
    expect(latest.windowDays).toBe(1);
    expect(latest.aggregate.turns).toBe(1);
    expect(latest.aggregate.taskSuccessRate).toBe(1);
    expect(latest.aggregate).not.toHaveProperty("daily");
    expect(latest.generatedAt).toBe(NOW().toISOString());
  });

  it("survives a corrupted session file by skipping it", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "eval-metrics-"));
    const log = createSessionEventLog({ rootDir, now: NOW });
    for (const item of successfulTurnEvents({ sessionId: "good", runId: "r1" })) {
      await log.append({ ...item, sessionId: "good" });
    }
    await writeFile(path.join(rootDir, "sessions", "corrupt.jsonl"), "{not json}\n", "utf8");
    const service = createEvalMetricsService({ sessionEventLog: log, now: NOW });
    const report = await service.report({ windowDays: 7 });
    expect(report.aggregate.sessionsEvaluated).toBe(1);
    expect(report.aggregate.sessionsSkipped).toBe(1);
    expect(report.aggregate.turns).toBe(1);
  });
});

describe("sessionEventLog.list()", () => {
  it("scans the sessions directory and returns sorted session ids", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "eval-metrics-"));
    const log = createSessionEventLog({ rootDir, now: NOW });
    expect(await log.list()).toEqual([]);

    await log.append({ type: "session/start", sessionId: "beta", payload: {} });
    await log.append({ type: "session/start", sessionId: "alpha", payload: {} });
    await log.append({ type: "session/start", sessionId: "gamma-1.2", payload: {} });

    expect(await log.list()).toEqual(["alpha", "beta", "gamma-1.2"]);
  });
});
