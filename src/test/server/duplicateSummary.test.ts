import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveChatModelConfigMock = vi.fn();
const buildChatCompletionRequestMock = vi.fn();

vi.mock("../../../server/chatModelConfig.mjs", () => ({
  resolveChatModelConfig: (...args: unknown[]) => resolveChatModelConfigMock(...args),
  buildChatCompletionRequest: (...args: unknown[]) => buildChatCompletionRequestMock(...args),
}));

import { summarizeDuplicateResults } from "../../../server/duplicateSummary.mjs";

describe("summarizeDuplicateResults", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolveChatModelConfigMock.mockReset();
    buildChatCompletionRequestMock.mockReset();
    resolveChatModelConfigMock.mockReturnValue({ model: "test-model", credential: "token" });
    buildChatCompletionRequestMock.mockImplementation(({ messages }: { messages: Array<{ role: string; content: string }> }) => ({
      url: "https://example.invalid",
      headers: {},
      body: { messages },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes multiline evidence and keeps at most two evidence lines in the summary request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "候选 1 最可能重复。" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await summarizeDuplicateResults(
      "导航黄屏",
      {
        candidates: [
          {
            ticketId: "2686999",
            name: "导航黄屏 related defect",
            score1to10: 8,
            project: "IDCEVO",
            pu: "26-07",
            statusPhase: "03-In Analysis",
            snippet: "与导航黑屏和黄屏相关的历史缺陷。",
            evidenceSnippets: [
              "分析结论：HU wake timeout\nafter KL15 on.",
              " 日志显示 wake sequence\r\n 中断。 ",
              "这条不应该进入 prompt。",
            ],
          },
        ],
        modelPhase: "click_boost",
        feedbackCount: 0,
      },
      "mock-model",
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.messages[0].content).toContain("优先使用 comments/evidence 中的分析过程");
    expect(requestBody.messages[0].content).toContain("不得改写该候选的置信度等级");
    expect(requestBody.messages[1].content).toContain("证据1: 分析结论：HU wake timeout after KL15 on.");
    expect(requestBody.messages[1].content).toContain("证据2: 日志显示 wake sequence 中断。");
    expect(requestBody.messages[1].content).toContain("复核置信度: 高置信 (8/10)");
    expect(requestBody.messages[1].content).toContain("相似度分数: 8/10");
    expect(requestBody.messages[1].content).not.toContain("这条不应该进入 prompt。");
    expect(requestBody.messages[1].content).not.toContain("\nafter KL15 on.");
    expect(requestBody.messages[1].content).not.toContain("wake sequence\r\n 中断");
  });

  it("returns per-candidate review focus from structured company LLM output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summaryText: "当前排序第一候选 2754092，需要核对平台和日志。",
                candidateAnalyses: [
                  {
                    ticketId: "2754092",
                    reviewFocus: "Likely wake-up symptom match; compare platform, trigger path, timestamp and logs.",
                  },
                ],
              }),
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeDuplicateResults(
      "speech can not wakeup",
      {
        candidates: [
          {
            ticketId: "2754092",
            name: "Speech can not be wake up",
            score1to10: 6,
            snippet: "wake up speech issue",
          },
        ],
        modelPhase: "click_boost",
        feedbackCount: 0,
      },
      "deepseek-v4-flash",
      { language: "en" },
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.messages[0].content).toContain("Output in English");
    expect(summary.summarySource).toBe("llm");
    expect(summary.summaryText).toContain("Current top candidate: 2754092");
    expect(summary.candidateAnalyses).toEqual([
      {
        ticketId: "2754092",
        reviewFocus: "Likely wake-up symptom match; compare platform, trigger path, timestamp and logs.",
      },
    ]);
  });

  it("summarizes candidates in review-confidence order with separate similarity scores", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "{}" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeDuplicateResults(
      "speech can not wakeup",
      {
        candidates: [
          {
            ticketId: "2337201",
            name: "Speech did not work in any language",
            score1to10: 6,
            confidenceScore1to10: 6,
            snippet: "dense-only top match",
          },
          {
            ticketId: "2754092",
            name: "Speech can not be wake up",
            score1to10: 6,
            confidenceScore1to10: 7,
            snippet: "sparse and evidence supported match",
          },
        ],
        modelPhase: "click_boost",
        feedbackCount: 0,
      },
      "mock-model",
      { language: "en" },
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const prompt = requestBody.messages[1].content;
    expect(prompt.indexOf("Ticket: 2754092")).toBeLessThan(prompt.indexOf("Ticket: 2337201"));
    expect(prompt).toContain("Review confidence: medium confidence (7/10)");
    expect(prompt).toContain("Similarity score: 6/10");
    expect(summary.summaryText.split("\n")[0]).toContain("Current top candidate: 2754092");
  });

  it("uses a concise fallback summary with bounded evidence when credentials are missing", async () => {
    resolveChatModelConfigMock.mockReturnValue({ model: "test-model", credential: "" });

    const summary = await summarizeDuplicateResults(
      "导航黄屏",
      {
        candidates: [
          {
            ticketId: "2686999",
            name: "导航黄屏 related defect",
            score1to10: 8,
            evidenceSnippets: [
              "第一条证据\n需要合并",
              "第二条证据",
              "第三条证据不会展示",
            ],
          },
        ],
        modelPhase: "click_boost",
        feedbackCount: 0,
      },
      "mock-model",
    );

    expect(summary.summarySource).toBe("fallback");
    expect(summary.summaryText).toContain("优先复核: D2686999");
    expect(summary.summaryText).toContain("复核置信度 高置信 (8/10)，相似度 8/10");
    expect(summary.summaryText).toContain("依据: 第一条证据 需要合并；第二条证据");
    expect(summary.summaryText).toContain("下一步: 核对平台、触发路径、时间戳和日志后再关联。");
    expect(summary.summaryText).not.toContain("现象匹配:");
    expect(summary.summaryText).not.toContain("候选概览:");
    expect(summary.summaryText).not.toContain("第三条证据不会展示");
    expect(summary.candidateAnalyses[0].reviewFocus).toContain("优先核对 comments/evidence");
    expect(summary.candidateAnalyses[0].reviewFocus).not.toContain("comments/evidence suggest");
  });

  it("uses fallback summary and marks evidence insufficient when fetch fails without evidence", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeDuplicateResults(
      "导航黄屏",
      {
        candidates: [
          {
            ticketId: "2686999",
            name: "导航黄屏 related defect",
            score1to10: 8,
          },
        ],
        modelPhase: "click_boost",
        feedbackCount: 0,
      },
      "mock-model",
    );

    expect(summary.summarySource).toBe("fallback");
    expect(summary.summaryText).toContain("依据: 当前候选缺少足够 comments 证据");
  });

  it("falls back when the summary model exceeds the configured timeout", async () => {
    const previousTimeout = process.env.DUPLICATE_SUMMARY_TIMEOUT_MS;
    process.env.DUPLICATE_SUMMARY_TIMEOUT_MS = "10";
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await Promise.race([
        summarizeDuplicateResults(
          "导航黄屏",
          {
            candidates: [
              {
                ticketId: "2686999",
                name: "导航黄屏 related defect",
                score1to10: 8,
              },
            ],
            modelPhase: "click_boost",
            feedbackCount: 0,
          },
          "mock-model",
        ),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 1000)),
      ]);

      expect(result).not.toBe("timed-out");
      expect(result).toEqual(
        expect.objectContaining({
          summarySource: "fallback",
          answerModel: "Duplicate Search Agent",
        }),
      );
      expect(fetchMock.mock.calls[0][1]?.signal).toBeTruthy();
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe("error");
    } finally {
      if (previousTimeout == null) {
        delete process.env.DUPLICATE_SUMMARY_TIMEOUT_MS;
      } else {
        process.env.DUPLICATE_SUMMARY_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("keeps the summary deadline active while the response body is parsed", async () => {
    const previousTimeout = process.env.DUPLICATE_SUMMARY_TIMEOUT_MS;
    process.env.DUPLICATE_SUMMARY_TIMEOUT_MS = "10";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("body aborted"), { name: "AbortError" }));
        });
      }),
    })));

    try {
      const summary = await summarizeDuplicateResults(
        "导航黄屏",
        {
          candidates: [],
          modelPhase: "click_boost",
          feedbackCount: 0,
        },
        "mock-model",
      );
      expect(summary).toEqual(expect.objectContaining({
        summarySource: "fallback",
        answerModel: "Duplicate Search Agent",
      }));
    } finally {
      if (previousTimeout == null) delete process.env.DUPLICATE_SUMMARY_TIMEOUT_MS;
      else process.env.DUPLICATE_SUMMARY_TIMEOUT_MS = previousTimeout;
    }
  });

  it("anchors llm summary first line to the top-ranked candidate and score", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                "最可能重复票: 2675387。标题“BT Phone can not connect after disconnect ACP”，直接匹配。\n判断: 标题与用户问题完全相同。\n建议: 优先核对日志。",
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeDuplicateResults(
      "BT Phone can not connect after disconnect ACP",
      {
        candidates: [
          {
            ticketId: "2633450",
            name: "[IDCevo][SV] Mobile device is connected but shows Disconnecting status on HMI",
            score1to10: 3,
            snippet: "ACP disconnect 相关现象，但相关性较弱。",
          },
          {
            ticketId: "2675387",
            name: "BT Phone can not connect after disconnect ACP",
            score1to10: 2,
            snippet: "标题直接相关，但当前排序不是第一。",
          },
        ],
        modelPhase: "click_boost",
        feedbackCount: 2,
      },
      "mock-model",
    );

    expect(summary.summarySource).toBe("llm");
    expect(summary.summaryText.split("\n")[0]).toBe(
      "当前排序第一候选: 2633450。标题“[IDCevo][SV] Mobile device is connected but shows Disconnecting status on HMI”，置信度: 弱相关，仅作复核起点。",
    );
    expect(summary.summaryText).toContain("判断: 标题与用户问题完全相同。");
  });
});
