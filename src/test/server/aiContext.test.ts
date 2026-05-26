import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAiDefectContextCache,
  resolveAiDefectContext,
} from "../../../server/aiContext.mjs";

describe("resolveAiDefectContext", () => {
  beforeEach(() => {
    clearAiDefectContextCache();
    vi.restoreAllMocks();
  });

  it("reuses cached duplicate search results for the same latest user query", async () => {
    const runDuplicateBridge = vi.fn().mockResolvedValue({
      success: true,
      result: {
        candidates: [
          {
            ticketId: "2686999",
            name: "导航黄屏 related defect",
            score1to10: 8,
            similarity: 0.88,
            project: "IDCEVO",
            pu: "26-07",
            statusPhase: "03-In Analysis_Medium",
            snippet: "与导航黑屏和黄屏相关的历史缺陷。",
          },
        ],
        modelPhase: "click_boost",
        feedbackCount: 0,
        dataset_size: 34717,
        timings: {
          total_ms: 32479.4,
          load_defect_df_ms: 412.8,
          get_or_build_index_ms: 31886.1,
          search_with_metadata_ms: 171.2,
          feedback_count_ms: 9.3,
          index_cache_hit: false,
          index_rebuilt: true,
        },
      },
    });

    const params = {
      runDuplicateBridge,
      messages: [{ role: "user", content: "请总结当前缺陷风险" }],
      topK: 5,
    };

    const first = await resolveAiDefectContext(params);
    const second = await resolveAiDefectContext(params);

    expect(runDuplicateBridge).toHaveBeenCalledTimes(1);
    expect(first.queryText).toBe("请总结当前缺陷风险");
    expect(second.queryText).toBe(first.queryText);
    expect(second.contextText).toBe(first.contextText);
    expect(second.duplicateSearchResult).toEqual(first.duplicateSearchResult);
    expect(first.timings).toEqual(
      expect.objectContaining({
        cacheHit: false,
        bridgeTimings: expect.objectContaining({
          total_ms: 32479.4,
          index_rebuilt: true,
        }),
      }),
    );
    expect(first.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(first.timings.bridgeMs).toBeGreaterThanOrEqual(0);
    expect(second.timings).toEqual(
      expect.objectContaining({
        cacheHit: true,
        bridgeTimings: expect.objectContaining({
          total_ms: 32479.4,
          index_rebuilt: true,
        }),
      }),
    );
    expect(second.timings.totalMs).toBeGreaterThanOrEqual(0);
  });
});