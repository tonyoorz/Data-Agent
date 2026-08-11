import { describe, expect, it } from "vitest";

import {
  characterErrorRate,
  summarizeProviderResults,
  validateBenchmarkManifest,
} from "../../../scripts/benchmarkTranscription.mjs";

describe("ASR benchmark metrics", () => {
  it("calculates character error rate after normalizing whitespace and case", () => {
    expect(characterErrorRate("IDCEVO ECU", "idcevo  ecu")).toEqual({
      distance: 0,
      referenceChars: 9,
      rate: 0,
    });

    expect(characterErrorRate("车机控制器", "车机控置器")).toEqual({
      distance: 1,
      referenceChars: 5,
      rate: 0.2,
    });
  });

  it("summarizes accuracy, successful-request latency, failure rate, and optional cost", () => {
    const summary = summarizeProviderResults([
      {
        success: true,
        reference: "AB",
        transcript: "AB",
        latencyMs: 100,
        costCny: 0.01,
        categories: ["chinese"],
      },
      {
        success: true,
        reference: "AB",
        transcript: "AC",
        latencyMs: 300,
        costCny: 0.02,
        categories: ["mixed-language"],
      },
      {
        success: false,
        reference: "",
        transcript: "",
        latencyMs: 400,
        categories: ["noise"],
      },
    ]);

    expect(summary).toMatchObject({
      attempts: 3,
      successes: 2,
      failures: 1,
      failureRate: 1 / 3,
      characterErrorRate: {
        distance: 1,
        referenceChars: 4,
        rate: 0.25,
      },
      successfulLatencyMs: {
        p50: 200,
        p95: 290,
      },
      estimatedCostCny: 0.03,
    });
    expect(summary.byCategory.chinese.attempts).toBe(1);
    expect(summary.byCategory.noise.failures).toBe(1);
  });

  it("requires a 30 to 50 sample manifest with the benchmark fields", () => {
    const sample = {
      id: "sample",
      audioPath: "fixtures/sample.webm",
      reference: "测试文本",
      categories: ["chinese"],
    };

    expect(() => validateBenchmarkManifest({ samples: Array.from({ length: 29 }, (_, index) => ({ ...sample, id: `${index}` })) }))
      .toThrow(/30 to 50/i);
    expect(() => validateBenchmarkManifest({ samples: Array.from({ length: 30 }, (_, index) => ({ ...sample, id: `${index}` })) }))
      .not.toThrow();
  });
});