import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  FAKE_MODEL_ID,
  fetchWithTimeout,
  parseSseEvents,
  startLocalAgentHarness,
} from "./agentRuntimeHarness.mjs";

const TERMINAL_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const DEFAULT_QUERIES = Object.freeze([
  "2026 年 DTSV 有多少缺陷？",
  "最近一周缺陷高频模块",
  "给蓝牙断连缺陷做查重",
  "dashboard summary 给我看一下",
]);

function hashRef(value) {
  return value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 16) : undefined;
}

function safeCode(value, fallback = "LOAD_REQUEST_FAILED") {
  const raw = String(value || "");
  return /^[A-Z][A-Z0-9_:-]{2,79}$/.test(raw) ? raw : fallback;
}

function safeError(error) {
  if (!error) return undefined;
  return {
    ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    code: safeCode(error.code),
  };
}

function summarizeIteration(item) {
  return {
    index: item.index,
    runRef: hashRef(item.runId),
    threadRef: hashRef(item.threadId),
    status: item.status,
    startLatencyMs: item.startLatencyMs,
    latencyMs: item.latencyMs,
    eventCount: item.eventCount,
    terminalEventCount: item.terminalEventCount,
    duplicateEventCount: item.duplicateEventCount,
    isolationViolations: item.isolationViolations,
    duplicateToolExecutions: item.duplicateToolExecutions,
    error: safeError(item.error),
  };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`INVALID_${label}`);
  return number;
}

function createPrng(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
}

function errorFromResponse(status, body) {
  return {
    status,
    code: safeCode(body?.code, `HTTP_${status}`),
    message: String(body?.safeMessage || body?.message || body?.code || `HTTP ${status}`),
  };
}

export async function executeLoadIteration({
  baseUrl,
  index,
  query,
  timeoutMs,
  harness,
} = {}) {
  const startedAt = Date.now();
  const requestBody = {
    schemaVersion: "1.0",
    messageId: `load-${index}-${randomUUID()}`,
    threadVersion: 0,
    message: { role: "user", text: query, artifactRefs: [] },
    selectedModel: FAKE_MODEL_ID,
    useDefectContext: /查重|重复|duplicate/i.test(query),
    useAnalyticsContext: !/查重|重复|duplicate/i.test(query),
    eventProtocolVersion: "1.0",
  };
  let runId;
  let threadId;
  let events = [];
  let error;
  let startLatencyMs;
  try {
    const startResponse = await fetchWithTimeout(`${baseUrl}/api/agent/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(requestBody),
    }, timeoutMs);
    startLatencyMs = Date.now() - startedAt;
    const startBody = await startResponse.json();
    if (startResponse.status !== 202) {
      error = errorFromResponse(startResponse.status, startBody);
    } else {
      runId = startBody.runId;
      threadId = startBody.threadId;
      const streamResponse = await fetchWithTimeout(`${baseUrl}${startBody.eventsUrl}?follow=1`, {
        headers: { accept: 'text/event-stream; profile="agent-v1"' },
      }, timeoutMs);
      if (!streamResponse.ok) {
        error = errorFromResponse(streamResponse.status, await streamResponse.json());
      } else {
        events = parseSseEvents(await streamResponse.text());
      }
    }
  } catch (caught) {
    error = {
      code: caught?.name === "AbortError" ? "REQUEST_TIMEOUT" : safeCode(caught?.code),
      message: String(caught?.message || caught || "LOAD_REQUEST_FAILED"),
    };
  }

  const terminals = events.filter((event) => TERMINAL_TYPES.has(event.type));
  const eventIds = events.map((event) => event.eventId).filter(Boolean);
  const uniqueEventIds = new Set(eventIds);
  const toolAttemptIds = events.filter((event) => event.type === "tool.started").map((event) => event.payload?.attemptId).filter(Boolean);
  const uniqueToolAttempts = new Set(toolAttemptIds);
  if (!error && terminals.length !== 1) {
    error = { code: terminals.length ? "DUPLICATE_TERMINAL_EVENT" : "TERMINAL_EVENT_MISSING", message: `Observed ${terminals.length} terminal events` };
  }
  const run = runId && harness
    ? harness.deps.threadStore.getRun({ actor: harness.actor, runId })
    : undefined;

  return {
    index,
    query,
    runId,
    threadId,
    status: run?.status || (terminals.at(-1)?.type || "").replace("run.", "") || null,
    startLatencyMs: startLatencyMs ?? null,
    latencyMs: Date.now() - startedAt,
    eventCount: events.length,
    terminalEventCount: terminals.length,
    duplicateEventCount: Math.max(0, eventIds.length - uniqueEventIds.size),
    isolationViolations: events.filter((event) => runId && event.runId !== runId).length,
    duplicateToolExecutions: Math.max(0, toolAttemptIds.length - uniqueToolAttempts.size),
    error,
  };
}

export async function runLoadTest({
  iterations = 5,
  concurrency = 2,
  timeoutMs = 10000,
  maxP95Ms = 2000,
  seed = 20260716,
  baseUrl,
  queries = DEFAULT_QUERIES,
  executeIteration,
} = {}) {
  const iterationCount = positiveInteger(iterations, "ITERATIONS");
  const workerCount = Math.min(iterationCount, positiveInteger(concurrency, "CONCURRENCY"));
  const requestTimeoutMs = positiveInteger(timeoutMs, "TIMEOUT_MS");
  const p95ObjectiveMs = positiveInteger(maxP95Ms, "MAX_P95_MS");
  if (!Array.isArray(queries) || queries.length === 0) throw new Error("LOAD_QUERIES_REQUIRED");
  const random = createPrng(seed);
  const selectedQueries = Array.from({ length: iterationCount }, () => queries[Math.floor(random() * queries.length)]);
  const harness = baseUrl || executeIteration ? null : await startLocalAgentHarness({
    policyOptions: {
      runStartRatePerMinute: Math.max(6000, iterationCount * 60),
      runStartBurst: iterationCount + workerCount,
      actorActiveRunLimit: workerCount,
      globalActiveRunLimit: workerCount,
    },
  });
  const targetBaseUrl = baseUrl || harness?.baseUrl;
  const runner = executeIteration || ((input) => executeLoadIteration(input));
  const results = new Array(iterationCount);
  let nextIndex = 0;
  const startedAt = Date.now();

  async function worker() {
    while (nextIndex < iterationCount) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await runner({
        baseUrl: targetBaseUrl,
        index,
        query: selectedQueries[index],
        timeoutMs: requestTimeoutMs,
        harness,
      });
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    await harness?.cleanup();
  }

  const latencies = results.map((item) => item.latencyMs).filter(Number.isFinite);
  const startLatencies = results.map((item) => item.startLatencyMs).filter(Number.isFinite);
  const errors = results.filter((item) => item.error);
  const terminalCount = results.filter((item) => item.terminalEventCount === 1).length;
  const isolationViolations = results.reduce((sum, item) => sum + item.isolationViolations, 0);
  const duplicateEvents = results.reduce((sum, item) => sum + item.duplicateEventCount, 0);
  const duplicateToolExecutions = results.reduce((sum, item) => sum + item.duplicateToolExecutions, 0);
  const safeResults = results.map(summarizeIteration);
  const p95LatencyMs = percentile(latencies, 0.95);
  const qualificationGates = {
    errorRate: { pass: errors.length === 0, actual: errors.length / iterationCount, objective: 0 },
    terminalEventCoverage: { pass: terminalCount === iterationCount, actual: terminalCount / iterationCount, objective: 1 },
    p95LatencyMs: { pass: p95LatencyMs != null && p95LatencyMs <= p95ObjectiveMs, actual: p95LatencyMs, objective: `<= ${p95ObjectiveMs}` },
    duplicateEvents: { pass: duplicateEvents === 0, actual: duplicateEvents, objective: 0 },
    isolationViolations: { pass: isolationViolations === 0, actual: isolationViolations, objective: 0 },
    duplicateToolExecutions: { pass: duplicateToolExecutions === 0, actual: duplicateToolExecutions, objective: 0 },
  };
  const report = {
    schemaVersion: "2.1",
    generatedAt: new Date().toISOString(),
    targetRef: hashRef(targetBaseUrl),
    localFixture: !baseUrl && !executeIteration,
    iterations: iterationCount,
    concurrency: workerCount,
    timeoutMs: requestTimeoutMs,
    seed: Number(seed),
    durationMs: Date.now() - startedAt,
    throughputPerSecond: (iterationCount * 1000) / Math.max(1, Date.now() - startedAt),
    latencyMs: {
      p50: percentile(latencies, 0.50),
      p95: p95LatencyMs,
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    startLatencyMs: {
      p50: percentile(startLatencies, 0.50),
      p95: percentile(startLatencies, 0.95),
      p99: percentile(startLatencies, 0.99),
    },
    errors: errors.length,
    errorRate: errors.length / iterationCount,
    terminalEventCoverage: terminalCount / iterationCount,
    duplicateEvents,
    isolationViolations,
    duplicateToolExecutions,
    qualificationGates,
    passed: Object.values(qualificationGates).every((item) => item.pass),
    errorSamples: errors.slice(0, 10).map((item) => summarizeIteration(item)),
    results: safeResults,
    environment: { node: process.version, platform: process.platform, cpus: os.cpus().length },
    qualificationPolicy: !baseUrl && !executeIteration ? {
      purpose: "capacity-test",
      runStartBurst: iterationCount + workerCount,
      actorActiveRunLimit: workerCount,
      globalActiveRunLimit: workerCount,
    } : null,
  };
  return report;
}
