import { describe, expect, it } from "vitest";

import {
  aggregateUsageRecords,
  parseChatSessionPatchLog,
  renderUsageReportHtml,
} from "../../../scripts/copilotUsageReport.mjs";

describe("parseChatSessionPatchLog", () => {
  it("reconstructs request usage from the stored patch log", () => {
    const lines = [
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: "s-1",
          creationDate: 1710000000000,
          inputState: {
            selectedModel: {
              identifier: "copilot/gpt-5.4",
              metadata: { inputCost: 250, outputCost: 1500 },
            },
          },
          requests: [],
        },
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [{ requestId: "r-1", timestamp: 1710000100000 }],
      }),
      JSON.stringify({
        kind: 1,
        k: ["requests", 0, "result"],
        v: { metadata: { promptTokens: 1200, outputTokens: 300 } },
      }),
      JSON.stringify({ kind: 1, k: ["requests", 0, "completionTokens"], v: 320 }),
      JSON.stringify({ kind: 1, k: ["requests", 0, "elapsedMs"], v: 4500 }),
    ];

    expect(parseChatSessionPatchLog(lines)).toMatchObject({
      sessionId: "s-1",
      selectedModel: "copilot/gpt-5.4",
      requestCount: 1,
      promptTokens: 1200,
      outputTokens: 300,
      completionTokens: 320,
      elapsedMs: 4500,
    });

    expect(parseChatSessionPatchLog(lines).usageEvents).toEqual([
      expect.objectContaining({
        timestamp: 1710000100000,
        model: "copilot/gpt-5.4",
        promptTokens: 1200,
        outputTokens: 300,
        elapsedMs: 4500,
        estimatedCost: 0.75,
      }),
    ]);
  });
});

describe("aggregateUsageRecords", () => {
  it("groups totals by model and by day and estimates cost", () => {
    const summary = aggregateUsageRecords([
      {
        sessionId: "s-1",
        title: "Session one",
        selectedModel: "copilot/gpt-5.4",
        startedAt: "2026-06-08T10:00:00.000Z",
        updatedAt: "2026-06-08T10:05:00.000Z",
        requestCount: 1,
        promptTokens: 1200,
        outputTokens: 300,
        completionTokens: 320,
        elapsedMs: 4500,
        pricing: { inputCost: 250, outputCost: 1500 },
        usageEvents: [
          {
            timestamp: Date.parse("2026-06-08T10:00:00.000Z"),
            model: "copilot/gpt-5.4",
            promptTokens: 1200,
            outputTokens: 300,
            completionTokens: 320,
            elapsedMs: 4500,
            estimatedCost: 0.75,
          },
        ],
      },
    ]);

    expect(summary.totals.estimatedCost).toBeCloseTo(0.75, 5);
    expect(summary.byModel[0]).toMatchObject({
      model: "copilot/gpt-5.4",
      requestCount: 1,
      promptTokens: 1200,
      outputTokens: 300,
    });
    expect(summary.byDay[0]).toMatchObject({
      day: "2026-06-08",
      requestCount: 1,
    });
    expect(summary.usageEvents[0]).toMatchObject({
      model: "copilot/gpt-5.4",
      estimatedCost: 0.75,
    });
  });
});

describe("renderUsageReportHtml", () => {
  it("renders summary sections and usage event filters into standalone html", () => {
    const html = renderUsageReportHtml({
      generatedAt: "2026-06-09T00:00:00.000Z",
      totals: {
        sessionCount: 1,
        requestCount: 1,
        promptTokens: 1200,
        outputTokens: 300,
        completionTokens: 320,
        elapsedMs: 4500,
        estimatedCost: 0.75,
      },
      byModel: [
        {
          model: "copilot/gpt-5.4",
          sessionCount: 1,
          requestCount: 1,
          promptTokens: 1200,
          outputTokens: 300,
          completionTokens: 320,
          elapsedMs: 4500,
          estimatedCost: 0.75,
        },
      ],
      byDay: [
        {
          day: "2026-06-08",
          sessionCount: 1,
          requestCount: 1,
          promptTokens: 1200,
          outputTokens: 300,
          completionTokens: 320,
          elapsedMs: 4500,
          estimatedCost: 0.75,
        },
      ],
      topSessions: [
        {
          sessionId: "s-1",
          title: "Session one",
          model: "copilot/gpt-5.4",
          startedAt: "2026-06-08T10:00:00.000Z",
          updatedAt: "2026-06-08T10:05:00.000Z",
          requestCount: 1,
          promptTokens: 1200,
          outputTokens: 300,
          completionTokens: 320,
          elapsedMs: 4500,
          estimatedCost: 0.75,
        },
      ],
      usageEvents: [
        {
          timestamp: Date.parse("2026-06-08T10:00:00.000Z"),
          model: "copilot/gpt-5.4",
          promptTokens: 1200,
          outputTokens: 300,
          completionTokens: 320,
          elapsedMs: 4500,
          estimatedCost: 0.75,
          localTime: "2026/06/08 18:00:00",
          day: "2026-06-08",
          timeOfDay: "18:00",
          isAfterHours: true,
        },
      ],
      afterHours: {
        requestCount: 1,
        elapsedMs: 4500,
        latestLocalTime: "2026/06/08 18:00:00",
        byDay: [
          {
            day: "2026-06-08",
            requestCount: 1,
            elapsedMs: 4500,
            firstLocalTime: "2026/06/08 18:00:00",
            lastLocalTime: "2026/06/08 18:00:00",
          },
        ],
      },
      warnings: [],
    });

    expect(html).toContain("Copilot Usage History");
    expect(html).toContain("Estimated Cost");
    expect(html).toContain("copilot/gpt-5.4");
    expect(html).toContain("2026-06-08");
    expect(html).toContain("Usage Events");
    expect(html).toContain("After-hours");
    expect(html).toContain('id="after-time-filter"');
    expect(html).toContain("UTC+8");
  });
});