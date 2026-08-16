/**
 * P1-8: Online eval metrics — turn the durable session event stream into
 * weekly-visible operational metrics (task success, clarification, tool errors).
 *
 * Definitions (all derived from logs/session-events/<id>.jsonl):
 * - turn            = one `turn/start` event (matched to its `turn/end` by runId)
 * - completedTurn   = turn whose runId has a `turn/end`
 * - successfulTurn  = completed AND stoppedReason ∉ {budget_exceeded, approval_pending}
 *                     AND same runId produced an `agent/response`
 * - approvalPending = completed with stoppedReason === "approval_pending";
 *                     excluded from BOTH numerator and denominator of taskSuccessRate
 *                     (awaiting human decision ≠ model failure), reported as its own rate
 * - clarification   = turn containing a `tool/call` with name === "ask_clarification"
 * - toolErrorRate   = `tool/result` events with ok === false / all `tool/result` events
 * - tokenUsageTotal = sum of `agent/response` payload.tokenUsage (per-turn stream usage;
 *                     `agent/request` tokens are cumulative budget snapshots and would double count)
 * - answerValidationPassRate = `agent/response` with answerValidation.valid === true /
 *                     `agent/response` events carrying answerValidation
 */

import { readFileSync } from "node:fs";

const NON_SUCCESS_STOP_REASONS = new Set(["budget_exceeded", "approval_pending"]);
const APPROVAL_PENDING_REASON = "approval_pending";
const CLARIFICATION_TOOL_NAME = "ask_clarification";
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** UTC calendar day of an ISO timestamp ("2026-08-15T03:00:00.000Z" -> "2026-08-15"). */
function utcDayKey(isoTimestamp) {
  return String(isoTimestamp || "").slice(0, 10);
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function emptyTokenUsage() {
  return { input: 0, output: 0, total: 0 };
}

function addTokenUsage(target, usage) {
  if (!isRecord(usage)) return;
  target.input += Number(usage.input) || 0;
  target.output += Number(usage.output) || 0;
  target.total += Number(usage.total) || (Number(usage.input) || 0) + (Number(usage.output) || 0);
}

function newTurnRecord(runId, startedAt) {
  return {
    runId,
    startedAt,
    dayKey: utcDayKey(startedAt),
    completed: false,
    stoppedReason: "",
    hasResponse: false,
    toolCalls: 0,
    clarifications: 0,
  };
}

/**
 * Walk one session's event stream and collect per-turn records plus
 * session-global counters, each tagged with the UTC day of its originating event.
 */
export function collectEvalMetricParts(events) {
  const turns = [];
  /** runId-keyed queues: open turns first, then closed ones lacking a response. */
  const byRunId = new Map();
  const global = {
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    tokenUsageTotal: emptyTokenUsage(),
    answerValidations: 0,
    answerValidationPassed: 0,
    runtimeErrors: 0,
  };
  const daily = new Map();

  function dailyBucket(dayKey) {
    let bucket = daily.get(dayKey);
    if (!bucket) {
      bucket = {
        toolCalls: 0,
        toolResults: 0,
        toolErrors: 0,
        tokenUsageTotal: emptyTokenUsage(),
        answerValidations: 0,
        answerValidationPassed: 0,
        runtimeErrors: 0,
        turns: 0,
      };
      daily.set(dayKey, bucket);
    }
    return bucket;
  }

  function runKey(event) {
    return String(event?.payload?.runId ?? "");
  }

  function findTurnForEvent(event) {
    const key = runKey(event);
    // Runtime tool events (tool/call, tool/result) carry no runId: attribute
    // them to the currently open turn (last turn/start without turn/end).
    if (!key) {
      const openAny = turns.findLast?.((turn) => !turn.completed) ?? [...turns].reverse().find((turn) => !turn.completed);
      if (openAny) return openAny;
      return turns.length ? turns[turns.length - 1] : null;
    }
    const candidates = byRunId.get(key);
    if (!candidates || !candidates.length) return null;
    // Prefer the first still-open turn (no turn/end yet)…
    const open = candidates.find((turn) => !turn.completed);
    if (open) return open;
    // …otherwise the most recent closed turn without a response (agent/response
    // is appended after turn/end by the streaming handler).
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (!candidates[index].hasResponse) return candidates[index];
    }
    return candidates[candidates.length - 1];
  }

  for (const event of events || []) {
    const dayKey = utcDayKey(event?.recordedAt);
    switch (event?.type) {
      case "turn/start": {
        const record = newTurnRecord(runKey(event), event?.recordedAt);
        turns.push(record);
        const key = record.runId;
        if (!byRunId.has(key)) byRunId.set(key, []);
        byRunId.get(key).push(record);
        dailyBucket(dayKey).turns += 1;
        break;
      }
      case "turn/end": {
        const turn = findTurnForEvent(event);
        if (turn) {
          turn.completed = true;
          turn.stoppedReason = String(event?.payload?.stoppedReason ?? "");
        }
        break;
      }
      case "agent/response": {
        const payload = event?.payload;
        addTokenUsage(global.tokenUsageTotal, payload?.tokenUsage);
        addTokenUsage(dailyBucket(dayKey).tokenUsageTotal, payload?.tokenUsage);
        if (isRecord(payload?.answerValidation)) {
          global.answerValidations += 1;
          dailyBucket(dayKey).answerValidations += 1;
          if (payload.answerValidation.valid === true) {
            global.answerValidationPassed += 1;
            dailyBucket(dayKey).answerValidationPassed += 1;
          }
        }
        const turn = findTurnForEvent(event);
        if (turn) turn.hasResponse = true;
        break;
      }
      case "tool/call": {
        global.toolCalls += 1;
        dailyBucket(dayKey).toolCalls += 1;
        const turn = findTurnForEvent(event);
        if (turn && String(event?.payload?.name ?? "") === CLARIFICATION_TOOL_NAME) turn.clarifications += 1;
        break;
      }
      case "tool/result": {
        global.toolResults += 1;
        dailyBucket(dayKey).toolResults += 1;
        if (event?.payload?.ok === false) {
          global.toolErrors += 1;
          dailyBucket(dayKey).toolErrors += 1;
        }
        break;
      }
      case "error/runtime": {
        global.runtimeErrors += 1;
        dailyBucket(dayKey).runtimeErrors += 1;
        break;
      }
      default:
        break;
    }
  }

  return { turns, global, daily };
}

/** Summarize collected turn records + global counters into the metric shape. */
function aggregateEvalMetricParts({ turns, global, daily }) {
  const totalTurns = turns.length;
  const completedTurns = turns.filter((turn) => turn.completed).length;
  const approvalPendingTurns = turns.filter(
    (turn) => turn.completed && turn.stoppedReason === APPROVAL_PENDING_REASON,
  ).length;
  const successfulTurns = turns.filter(
    (turn) =>
      turn.completed &&
      turn.hasResponse &&
      !NON_SUCCESS_STOP_REASONS.has(turn.stoppedReason),
  ).length;
  const clarificationTurns = turns.filter((turn) => turn.clarifications > 0).length;
  const evaluableTurns = completedTurns - approvalPendingTurns;

  return {
    turns: totalTurns,
    completedTurns,
    successfulTurns,
    failedTurns: evaluableTurns - successfulTurns,
    approvalPendingTurns,
    evaluableTurns,
    taskSuccessRate: ratio(successfulTurns, evaluableTurns),
    clarificationTurns,
    clarificationRate: ratio(clarificationTurns, totalTurns),
    approvalPendingRate: ratio(approvalPendingTurns, completedTurns),
    toolCalls: global.toolCalls,
    toolResults: global.toolResults,
    toolErrors: global.toolErrors,
    toolErrorRate: ratio(global.toolErrors, global.toolResults),
    avgToolCallsPerTurn: ratio(global.toolCalls, totalTurns),
    tokenUsageTotal: { ...global.tokenUsageTotal },
    answerValidations: global.answerValidations,
    answerValidationPassed: global.answerValidationPassed,
    answerValidationPassRate: ratio(global.answerValidationPassed, global.answerValidations),
    runtimeErrors: global.runtimeErrors,
  };
}

/**
 * Pure derivation of eval metrics for ONE session's event array.
 * `options.now` is accepted for signature symmetry (unused: session-level
 * derivation is timestamp-independent).
 */
export function deriveEvalMetrics(events, { now } = {}) {
  void now;
  return aggregateEvalMetricParts(collectEvalMetricParts(events));
}

function mergeGlobal(target, source) {
  target.toolCalls += source.toolCalls;
  target.toolResults += source.toolResults;
  target.toolErrors += source.toolErrors;
  addTokenUsage(target.tokenUsageTotal, source.tokenUsageTotal);
  target.answerValidations += source.answerValidations;
  target.answerValidationPassed += source.answerValidationPassed;
  target.runtimeErrors += source.runtimeErrors;
}

function lastRecordedAt(events) {
  let last = null;
  for (const event of events) {
    if (event?.recordedAt && (!last || event.recordedAt > last)) last = event.recordedAt;
  }
  return last;
}

/**
 * Cross-session aggregation service over the durable session event log.
 * Window filtering uses each session's LAST event timestamp, so long-running
 * sessions stay visible while stale ones drop out. Daily series are UTC-day
 * buckets of the originating events, zero-filled across the window.
 */
export function createEvalMetricsService({ sessionEventLog, now = () => new Date() } = {}) {
  if (!sessionEventLog) throw new Error("EVAL_METRICS_INVALID: sessionEventLog is required");

  async function collectSessionParts(windowStartMs) {
    const sessionIds = await sessionEventLog.list();
    const partsPerSession = [];
    let sessionsEvaluated = 0;
    let sessionsSkipped = 0;
    for (const sessionId of sessionIds) {
      let events;
      try {
        events = await sessionEventLog.read(sessionId);
      } catch {
        sessionsSkipped += 1;
        continue;
      }
      if (!events.length) continue;
      const lastAt = lastRecordedAt(events);
      const lastMs = lastAt ? Date.parse(lastAt) : NaN;
      if (!Number.isFinite(lastMs) || lastMs < windowStartMs) {
        sessionsSkipped += 1;
        continue;
      }
      sessionsEvaluated += 1;
      partsPerSession.push(collectEvalMetricParts(events));
    }
    return { partsPerSession, sessionsEvaluated, sessionsSkipped };
  }

  function mergeParts(partsPerSession) {
    const turns = [];
    const global = {
      toolCalls: 0,
      toolResults: 0,
      toolErrors: 0,
      tokenUsageTotal: emptyTokenUsage(),
      answerValidations: 0,
      answerValidationPassed: 0,
      runtimeErrors: 0,
    };
    const daily = new Map();
    for (const parts of partsPerSession) {
      turns.push(...parts.turns);
      mergeGlobal(global, parts.global);
      for (const [dayKey, bucket] of parts.daily.entries()) {
        let merged = daily.get(dayKey);
        if (!merged) {
          merged = {
            toolCalls: 0,
            toolResults: 0,
            toolErrors: 0,
            tokenUsageTotal: emptyTokenUsage(),
            answerValidations: 0,
            answerValidationPassed: 0,
            runtimeErrors: 0,
            turns: 0,
          };
          daily.set(dayKey, merged);
        }
        mergeGlobal(merged, bucket);
        merged.turns += bucket.turns;
      }
    }
    return { turns, global, daily };
  }

  return {
    /** Aggregate all in-window sessions plus a per-day trend series. */
    async report({ windowDays = 7 } = {}) {
      const days = Math.max(1, Math.min(90, Math.floor(Number(windowDays) || 7)));
      const nowDate = typeof now === "function" ? now() : new Date();
      const windowStartMs = nowDate.getTime() - days * DAY_MS;

      const { partsPerSession, sessionsEvaluated, sessionsSkipped } = await collectSessionParts(windowStartMs);
      const merged = mergeParts(partsPerSession);
      const aggregate = aggregateEvalMetricParts(merged);
      aggregate.sessionsEvaluated = sessionsEvaluated;
      aggregate.sessionsSkipped = sessionsSkipped;

      // Zero-filled UTC day series covering the last `days` days (today inclusive).
      const turnsByDay = new Map();
      for (const turn of merged.turns) {
        if (!turnsByDay.has(turn.dayKey)) turnsByDay.set(turn.dayKey, []);
        turnsByDay.get(turn.dayKey).push(turn);
      }
      const daily = [];
      const todayKey = utcDayKey(nowDate.toISOString());
      for (let offset = days - 1; offset >= 0; offset -= 1) {
        const dayKey = utcDayKey(new Date(nowDate.getTime() - offset * DAY_MS).toISOString());
        const bucket = merged.daily.get(dayKey) || {
          toolCalls: 0,
          toolResults: 0,
          toolErrors: 0,
          tokenUsageTotal: emptyTokenUsage(),
          answerValidations: 0,
          answerValidationPassed: 0,
          runtimeErrors: 0,
          turns: 0,
        };
        const dayTurns = aggregateEvalMetricParts({
          turns: turnsByDay.get(dayKey) || [],
          global: { toolCalls: 0, toolResults: 0, toolErrors: 0, tokenUsageTotal: emptyTokenUsage(), answerValidations: 0, answerValidationPassed: 0, runtimeErrors: 0 },
          daily: null,
        });
        daily.push({
          date: dayKey,
          turns: bucket.turns,
          taskSuccessRate: dayTurns.taskSuccessRate,
          toolCalls: bucket.toolCalls,
          toolResults: bucket.toolResults,
          toolErrors: bucket.toolErrors,
          toolErrorRate: ratio(bucket.toolErrors, bucket.toolResults),
          tokenUsageTotal: { ...bucket.tokenUsageTotal },
          runtimeErrors: bucket.runtimeErrors,
        });
        if (dayKey === todayKey) daily[daily.length - 1].isToday = true;
      }

      return { windowDays: days, aggregate, daily, generatedAt: nowDate.toISOString() };
    },

    /** Quick top-line for the last 24h (dashboards / heartbeat checks). */
    async latest() {
      const { windowDays, aggregate, generatedAt } = await this.report({ windowDays: 1 });
      return {
        windowDays,
        generatedAt,
        aggregate: {
          sessionsEvaluated: aggregate.sessionsEvaluated,
          turns: aggregate.turns,
          completedTurns: aggregate.completedTurns,
          taskSuccessRate: aggregate.taskSuccessRate,
          clarificationRate: aggregate.clarificationRate,
          toolErrorRate: aggregate.toolErrorRate,
          approvalPendingRate: aggregate.approvalPendingRate,
          runtimeErrors: aggregate.runtimeErrors,
        },
      };
    },
  };
}

/**
 * Offline-vs-online divergence (P0-A5): compare offline golden accuracy with
 * online taskSuccessRate. Drift flag = offline minus online > threshold with
 * enough online samples — signals production query distribution drift.
 */
const OFFLINE_ONLINE_DRIFT_PP = 15;
const OFFLINE_ONLINE_MIN_ONLINE_TURNS = 10;

export function deriveOfflineVsOnline({ offline, online }) {
  if (!offline || typeof offline.accuracy !== "number") {
    return { offline: null, online: online ?? null, divergencePp: null, drift: false, note: "无离线基线（先跑 npm run test:eval --update-baseline）" };
  }
  if (!online || typeof online.successRate !== "number") {
    return { offline, online: null, divergencePp: null, drift: false, note: "无线上样本" };
  }
  const divergencePp = Number(((offline.accuracy - online.successRate) * 100).toFixed(4));
  const enoughOnline = (online.n ?? 0) >= OFFLINE_ONLINE_MIN_ONLINE_TURNS;
  if (!enoughOnline) {
    return { offline, online, divergencePp, drift: false, note: `样本不足（线上 n=${online.n ?? 0} < ${OFFLINE_ONLINE_MIN_ONLINE_TURNS}）` };
  }
  const drift = divergencePp > OFFLINE_ONLINE_DRIFT_PP;
  const note = drift
    ? `线上分布漂移：离线 ${offline.accuracy} vs 线上 ${online.successRate}（差 ${divergencePp.toFixed(1)}pp > ${OFFLINE_ONLINE_DRIFT_PP}pp）`
    : "正常";
  return { offline, online, divergencePp, drift, note };
}

/** Read the stored offline eval baseline (written by scripts/evalRegression.mjs). */
export function readOfflineBaseline(baselinePath = new URL("../../src/test/server/evals/baseline.json", import.meta.url)) {
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    return null;
  }
}
