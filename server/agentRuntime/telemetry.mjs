import { createHash, randomUUID } from "node:crypto";
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";

const SAFE_ATTRIBUTE_KEYS = new Set([
  "runId", "threadId", "node", "toolName", "toolVersion", "graphVersion", "ontologyVersion", "ontologyFingerprint",
  "modelId", "status", "code", "retryable", "attempt", "evidenceCount", "claimCount", "citationCount", "groundingStatus",
  "inputTokens", "outputTokens", "durationMs", "firstEventMs", "timeToFinalMs", "recovered", "runtimeMode",
  "intent", "metricCount", "ambiguityCount", "messageCount", "summaryCount", "toolCount",
]);

export function safeTelemetryReference(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function summarizeSensitiveText(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return Object.freeze({
    length: [...normalized].length,
    contentHash: createHash("sha256").update(normalized).digest("hex"),
  });
}

export function summarizeNumericText(value) {
  const tokens = [...String(value || "").matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b[A-Za-z][A-Za-z0-9_-]*-\d+\b|\b\d+(?:\.\d+)?%?\b/g)]
    .map((match) => match[0])
    .sort();
  return Object.freeze({
    numericTokenCount: tokens.length,
    numericSignature: createHash("sha256").update(JSON.stringify(tokens)).digest("hex"),
  });
}

export function safeTelemetryErrorCode(error, fallback = "OPERATION_FAILED") {
  const raw = String(error?.code || error || "");
  return /^[A-Z][A-Z0-9_:-]{2,79}$/.test(raw) ? raw : fallback;
}

function sanitize(attributes = {}) {
  const result = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key) || value == null) continue;
    if (key === "code") {
      result.code = safeTelemetryErrorCode(value);
      continue;
    }
    result[key.endsWith("Id") && !["toolName", "modelId"].includes(key) ? `${key}Hash` : key] = key.endsWith("Id") && !["toolName", "modelId"].includes(key) ? safeTelemetryReference(value) : value;
  }
  return result;
}

export function createRuntimeTelemetry({
  logger = console,
  nowMs = () => performance.now(),
  sampleRate = 1,
  tracer = trace.getTracer("data-agent.main-agent", "2.0.0"),
  meter = metrics.getMeter("data-agent.main-agent", "2.0.0"),
} = {}) {
  const counters = new Map();
  const durations = new Map();
  const otelCounters = new Map();
  const otelHistograms = new Map();
  const sampled = () => sampleRate >= 1 || Math.random() < sampleRate;
  const record = (name, attributes = {}) => {
    counters.set(name, (counters.get(name) || 0) + 1);
    const safeAttributes = sanitize(attributes);
    let counter = otelCounters.get(name);
    if (!counter) {
      counter = meter.createCounter(`${name}.count`, { description: `Main Agent ${name} occurrences` });
      otelCounters.set(name, counter);
    }
    counter.add(1, safeAttributes);
    if (Number.isFinite(attributes.durationMs)) {
      const values = durations.get(name) || [];
      values.push(Number(attributes.durationMs));
      if (values.length > 1000) values.shift();
      durations.set(name, values);
      let histogram = otelHistograms.get(name);
      if (!histogram) {
        histogram = meter.createHistogram(`${name}.duration`, { unit: "ms", description: `Main Agent ${name} duration` });
        otelHistograms.set(name, histogram);
      }
      histogram.record(Number(attributes.durationMs), safeAttributes);
    }
    if (sampled()) logger.info?.(`[main-agent-telemetry] ${JSON.stringify({ name, ...safeAttributes })}`);
  };
  const startSpan = (name, attributes = {}) => {
    const startedAt = nowMs();
    const safeAttributes = sanitize(attributes);
    const otelSpan = tracer.startSpan(name, { attributes: safeAttributes });
    const spanId = otelSpan.spanContext?.().spanId || randomUUID();
    let ended = false;
    let finalDurationMs = 0;
    return Object.freeze({
      spanId,
      end(extra = {}) {
        if (ended) return finalDurationMs;
        ended = true;
        const durationMs = Math.max(0, nowMs() - startedAt);
        finalDurationMs = durationMs;
        const safeExtra = sanitize(extra);
        otelSpan.setAttributes?.(safeExtra);
        const failed = ["failed", "error", "denied", "cancelled", "timeout"].includes(String(extra.status || "").toLowerCase());
        otelSpan.setStatus?.({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK, ...(failed && extra.code ? { message: String(extra.code) } : {}) });
        otelSpan.end?.();
        record(name, { ...attributes, ...extra, durationMs });
        return durationMs;
      },
    });
  };
  const snapshot = () => ({
    counters: Object.fromEntries(counters),
    latency: Object.fromEntries([...durations].map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [name, { count: values.length, p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)] || 0, p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)] || 0 }];
    })),
  });
  return Object.freeze({ record, startSpan, snapshot });
}
