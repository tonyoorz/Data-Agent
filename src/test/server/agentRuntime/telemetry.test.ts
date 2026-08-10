// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createRuntimeTelemetry, safeTelemetryErrorCode, safeTelemetryReference, summarizeNumericText, summarizeSensitiveText } from "../../../../server/agentRuntime/telemetry.mjs";

describe("Agent Runtime OpenTelemetry bridge", () => {
  it("summarizes sensitive text and identifiers without retaining their raw values", () => {
    const summary = summarizeSensitiveText("  secret   question  ");

    expect(summary).toEqual({ length: 15, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(safeTelemetryReference("run-sensitive-1")).toMatch(/^[a-f0-9]{16}$/);
    expect(safeTelemetryReference("run-sensitive-1")).not.toContain("run-sensitive-1");
    expect(safeTelemetryErrorCode(new Error("provider returned SECRET"), "MODEL_FAILED")).toBe("MODEL_FAILED");
    expect(safeTelemetryErrorCode({ code: "TOOL_TIMEOUT" })).toBe("TOOL_TIMEOUT");
    const numeric = summarizeNumericText("答案 42，日期 2026-07-16；不要保留正文");
    expect(numeric).toEqual({ numericTokenCount: 2, numericSignature: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(numeric)).not.toContain("答案");
  });

  it("emits real spans and metrics with hashed identifiers and idempotent span completion", () => {
    const otelSpan = {
      spanContext: vi.fn(() => ({ spanId: "otel-span-1" })),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const counter = { add: vi.fn() };
    const histogram = { record: vi.fn() };
    const tracer = { startSpan: vi.fn(() => otelSpan) };
    const meter = { createCounter: vi.fn(() => counter), createHistogram: vi.fn(() => histogram) };
    const logger = { info: vi.fn() };
    const ticks = [100, 125];
    const telemetry = createRuntimeTelemetry({ tracer, meter, logger, nowMs: () => ticks.shift() ?? 125 });

    const span = telemetry.startSpan("agent.tool", { runId: "run-sensitive-1", toolName: "query_semantic_metrics", queryText: "secret question" });
    expect(span.spanId).toBe("otel-span-1");
    const firstDuration = span.end({ status: "failed", code: "TOOL_TIMEOUT", retryable: true });
    const secondDuration = span.end({ status: "failed", code: "TOOL_TIMEOUT" });

    expect(firstDuration).toBe(25);
    expect(secondDuration).toBe(25);
    expect(tracer.startSpan).toHaveBeenCalledWith("agent.tool", { attributes: expect.objectContaining({ runIdHash: expect.stringMatching(/^[a-f0-9]{16}$/), toolName: "query_semantic_metrics" }) });
    expect(JSON.stringify(tracer.startSpan.mock.calls)).not.toContain("run-sensitive-1");
    expect(JSON.stringify(tracer.startSpan.mock.calls)).not.toContain("secret question");
    expect(otelSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: 2, message: "TOOL_TIMEOUT" }));
    expect(otelSpan.end).toHaveBeenCalledTimes(1);
    expect(meter.createCounter).toHaveBeenCalledWith("agent.tool.count", expect.any(Object));
    expect(meter.createHistogram).toHaveBeenCalledWith("agent.tool.duration", expect.objectContaining({ unit: "ms" }));
    expect(counter.add).toHaveBeenCalledWith(1, expect.objectContaining({ runIdHash: expect.any(String), status: "failed" }));
    expect(histogram.record).toHaveBeenCalledWith(25, expect.objectContaining({ code: "TOOL_TIMEOUT" }));
    expect(telemetry.snapshot()).toMatchObject({ counters: { "agent.tool": 1 }, latency: { "agent.tool": { count: 1, p50Ms: 25, p95Ms: 25 } } });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("secret question");
  });
});
