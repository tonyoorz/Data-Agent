import { describe, expect, it, vi } from "vitest";

import { attachDuplicateSummary } from "../../../server/duplicateResultEnrichment.mjs";

describe("attachDuplicateSummary", () => {
  it("merges per-candidate review focus from summary analyses", async () => {
    const summarize = vi.fn().mockResolvedValue({
      summaryText: "summary from llm",
      answerModel: "deepseek-v4-flash",
      summarySource: "llm",
      candidateAnalyses: [
        {
          ticketId: "2754092",
          reviewFocus: "LLM analysis for wake-up overlap.",
        },
      ],
    });

    const result = await attachDuplicateSummary({
      query: "speech can not wakeup",
      selectedModel: "deepseek-v4-flash",
      result: {
        candidates: [
          { ticketId: "2754092", name: "Speech can not be wake up", reviewFocus: "old focus" },
          { ticketId: "2281701", name: "can't wake up speech by WUW.", reviewFocus: "keep me" },
        ],
        modelPhase: "click_boost",
        feedbackCount: 0,
      },
      summarizeDuplicateResults: summarize,
    });

    expect(summarize).toHaveBeenCalledWith(
      "speech can not wakeup",
      expect.objectContaining({ modelPhase: "click_boost" }),
      "deepseek-v4-flash",
      { language: undefined },
    );
    expect(result.summaryText).toBe("summary from llm");
    expect(result.answerModel).toBe("deepseek-v4-flash");
    expect(result.summarySource).toBe("llm");
    expect(result.candidates[0].reviewFocus).toBe("LLM analysis for wake-up overlap.");
    expect(result.candidates[1].reviewFocus).toBe("keep me");
  });
});