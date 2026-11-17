import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachDuplicateSummary } from "../../../server/duplicateResultEnrichment.mjs";
import { summarizeDuplicateResults } from "../../../server/duplicateSummary.mjs";

const baseResult = {
  searchId: "search-verdict-1",
  queryText: "IDCEVO 冷启动导航黑屏",
  modelPhase: "baseline",
  feedbackCount: 0,
  candidates: [
    {
      ticketId: "920669",
      name: "IDCEVO 冷启动导航黑屏",
      score1to10: 9,
      similarity: 0.91,
      snippet: "冷启动后导航黑屏，重启恢复。",
      evidenceSnippets: ["Comment analysis: 冷启动必现，PU26 一致。"],
    },
    {
      ticketId: "920670",
      name: "地图偶发白屏",
      score1to10: 6,
      similarity: 0.62,
      snippet: "地图渲染偶发白屏。",
    },
    {
      ticketId: "920671",
      name: "语音无法唤醒",
      score1to10: 4,
      similarity: 0.4,
      snippet: "语音唤醒失败。",
    },
  ],
};

function buildLlmContent() {
  return JSON.stringify({
    summaryText: "最可能重复票: 920669。\n依据: 现象与触发路径一致。\n下一步: 核对平台与日志。",
    candidateAnalyses: [
      {
        ticketId: "920669",
        reviewFocus: "核对冷启动触发路径与 PU26 日志。",
        verdict: "duplicate",
        verdictReason: "同为冷启动黑屏，PU 与现象一致。",
      },
      {
        ticketId: "920670",
        reviewFocus: "白屏与黑屏现象不同，需比对渲染链路。",
        verdict: "not_duplicate",
        verdictReason: "偶发白屏与必现黑屏现象不同。",
      },
      {
        ticketId: "920671",
        reviewFocus: "语音唤醒与导航显示无关。",
        verdict: "疑似重复",
        verdictReason: "措辞变体，现象一致。",
      },
    ],
  });
}

describe("duplicate summary verdicts", () => {
  beforeEach(() => {
    vi.stubEnv("DUPSEARCH_CHAT_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("parses per-candidate verdicts from the LLM response and normalizes Chinese variants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: buildLlmContent() } }],
        }),
      }),
    );

    const summary = await summarizeDuplicateResults("冷启动导航黑屏", baseResult, "");

    expect(summary.summarySource).toBe("llm");
    const byTicket = new Map(
      (summary.candidateAnalyses || []).map((item: { ticketId: string }) => [item.ticketId, item]),
    );
    expect(byTicket.get("920669")).toMatchObject({ verdict: "duplicate" });
    expect(byTicket.get("920670")).toMatchObject({ verdict: "not_duplicate" });
    expect(byTicket.get("920671")).toMatchObject({ verdict: "duplicate" });
  });

  it("drops invalid verdict values but keeps the review focus", async () => {
    const content = JSON.stringify({
      summaryText: "最可能重复票: 920669。",
      candidateAnalyses: [
        { ticketId: "920669", reviewFocus: "核对日志。", verdict: "maybe", verdictReason: "invalid value" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
      }),
    );

    const summary = await summarizeDuplicateResults("冷启动导航黑屏", baseResult, "");

    expect(summary.candidateAnalyses).toHaveLength(1);
    expect(summary.candidateAnalyses[0]).toMatchObject({
      ticketId: "920669",
      reviewFocus: "核对日志。",
      verdict: null,
    });
  });

  it("attaches verdicts onto candidates through the enrichment layer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: buildLlmContent() } }] }),
      }),
    );

    const enriched = await attachDuplicateSummary({
      query: "冷启动导航黑屏",
      selectedModel: "",
      result: baseResult,
    });

    const byTicket = new Map(
      (enriched.candidates || []).map((candidate: { ticketId: string }) => [candidate.ticketId, candidate]),
    );
    expect(byTicket.get("920669")).toMatchObject({
      llmVerdict: "duplicate",
      llmVerdictReason: "同为冷启动黑屏，PU 与现象一致。",
    });
    expect(byTicket.get("920670")).toMatchObject({ llmVerdict: "not_duplicate" });
    expect(byTicket.get("920671")).toMatchObject({ llmVerdict: "duplicate" });
  });

  it("does not fabricate verdicts in the deterministic fallback path", async () => {
    vi.stubEnv("DUPSEARCH_CHAT_API_KEY", "");

    const enriched = await attachDuplicateSummary({
      query: "冷启动导航黑屏",
      selectedModel: "",
      result: baseResult,
    });

    expect(enriched.summarySource).toBe("fallback");
    for (const candidate of enriched.candidates || []) {
      expect(candidate.llmVerdict).toBeUndefined();
    }
  });
});
