import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestCompanyChatCompletion, streamCompanyChatCompletion } from "../../../server/companyChat.mjs";
import { createOntologyRegistry } from "../../../server/ontology/registry.mjs";

describe("streamCompanyChatCompletion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.DUPSEARCH_CHAT_ACCESS_CODE = "test-access-code";
  });

  it("forwards upstream SSE chunks without waiting for response.json", async () => {
    const encoder = new TextEncoder();
    const write = vi.fn();
    const end = vi.fn();
    const writeHead = vi.fn();
    const response = {
      writeHead,
      write,
      end,
    };

    const json = vi.fn(async () => {
      throw new Error("json should not be called for streaming responses");
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
                'data: {"model":"deepseek-v4-flash","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      json,
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);
    const onMetrics = vi.fn();

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "hello" }],
      model: "deepseek-v4-flash",
      context: "ctx",
      response,
      onMetrics,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"stream":true'),
      }),
    );
    expect(json).not.toHaveBeenCalled();
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/event-stream; charset=utf-8",
      }),
    );
    const streamedText = write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");
    expect(streamedText).toContain('data: {"choices":[{"delta":{"content":"hello"}}]}');
    expect(streamedText).toContain("data: [DONE]");
    expect(end).toHaveBeenCalled();
    expect(onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkCount: 1,
        byteCount: expect.any(Number),
        upstreamConnectMs: expect.any(Number),
        firstChunkMs: expect.any(Number),
        streamTotalMs: expect.any(Number),
        tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      }),
    );
  });

  it("converts image message parts to OCR text before calling the text chat model", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const imageOcrRunner = vi.fn().mockResolvedValue({ text: "VIN: WBA123" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);
    const onAnswerValidation = vi.fn();

    await streamCompanyChatCompletion({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
          ],
        },
      ],
      model: "deepseek-v4-flash",
      response,
      imageOcrRunner,
    });

    expect(imageOcrRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: "data:image/png;base64,aW1hZ2U=",
        index: 1,
      }),
    );

    const upstreamBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const userMessage = upstreamBody.messages.find((message: { role: string }) => message.role === "user");
    expect(userMessage.content).toContain("read this image");
    expect(userMessage.content).toContain("Image 1 OCR text:\nVIN: WBA123");
    expect(userMessage.content).not.toContain("image_url");
  });

  it("converts PDF file message parts to extracted text before calling the text chat model", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const documentTextRunner = vi.fn().mockResolvedValue({ text: "Invoice total: 123 RMB" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "PDF 里说了什么" },
            {
              type: "file_data",
              file_data: {
                name: "invoice.pdf",
                mime_type: "application/pdf",
                url: "data:application/pdf;base64,JVBERi0xLjQ=",
              },
            },
          ],
        },
      ],
      model: "deepseek-v4-flash",
      response,
      documentTextRunner,
    });

    expect(documentTextRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        fileBase64: "JVBERi0xLjQ=",
        mimeType: "application/pdf",
        name: "invoice.pdf",
      }),
    );

    const upstreamBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const userMessage = upstreamBody.messages.find((message: { role: string }) => message.role === "user");
    expect(userMessage.content).toContain("PDF 里说了什么");
    expect(userMessage.content).toContain("Attachment 1 text from invoice.pdf:\nInvoice total: 123 RMB");
    expect(userMessage.content).not.toContain("file_data");
  });

  it("uses a grounded output protocol instead of asking the model to perform private reasoning", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "hello" }],
      model: "deepseek-v4-flash",
      response,
    });

    const upstreamBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const systemPrompt = upstreamBody.messages[0].content;
    expect(systemPrompt).not.toContain("narrate your work as an agent does");
    expect(systemPrompt).not.toContain("private reasoning");
    expect(systemPrompt).toContain("Do not invent tool use");
    expect(systemPrompt).toContain("Do not make causal claims");
    expect(systemPrompt).toContain("Only emit <step>");
  });

  it("prevents final answers from emitting DSML-style pseudo tool calls", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [
        { role: "user", content: "请基于近三个月的 Top Issue 数据，识别上升最快的三个问题模块" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "query_defect_aggregate", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          name: "query_defect_aggregate",
          content: JSON.stringify({ ok: false, error: "analytics API requires dataset" }),
        },
      ],
      model: "deepseek-v4-flash",
      context: "# Main agent tool result\nTool: query_defect_aggregate\nResult: unavailable because the analytics API requires dataset",
      response,
    });

    const upstreamBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const systemPrompt = upstreamBody.messages[0].content;
    const contextPrompt = upstreamBody.messages[1].content;

    expect(systemPrompt).toContain("Never emit DSML");
    expect(systemPrompt).toContain("<｜DSML｜tool_calls>");
    expect(systemPrompt).toContain("If more data is needed, state the limitation");
    expect(contextPrompt).toContain("Result: unavailable");
  });

  it("strips DSML-style pseudo tool calls from streamed final answer content", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"<｜DSML｜tool_calls><｜DSML｜invoke name=\\"query_defect_aggregate\\">bad</｜DSML｜invoke>"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"</｜DSML｜tool_calls>"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "请基于近三个月的 Top Issue 数据分析" }],
      model: "deepseek-v4-flash",
      context: "# Main agent tool result\nTool: query_defect_aggregate\nAggregate rows: none",
      response,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");

    expect(streamedText).not.toContain("DSML");
    expect(streamedText).not.toContain("query_defect_aggregate");
    expect(streamedText).not.toContain("tool_calls");
    expect(streamedText).toContain("无法继续调用工具");
    expect(streamedText).toContain("data: [DONE]");
  });

  it("strips DSML-style pseudo tool calls split across streamed content deltas", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"<｜DSML｜to"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"ol_calls>\\n<｜DSML｜invoke name=\\"query_analytics\\">"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"<｜DSML｜parameter name=\\"dataset\\" string=\\"true\\">defects</｜DSML｜parameter>"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"</｜DSML｜invoke>\\n</｜DSML｜tool_calls>"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "China Product 近三个月增长最快的 ECU 是什么" }],
      model: "deepseek-v4-flash",
      context: "# Main agent tool result\nTool: query_analytics\nAggregate rows: none",
      response,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");

    expect(streamedText).not.toContain("DSML");
    expect(streamedText).not.toContain("query_analytics");
    expect(streamedText).not.toContain("tool_calls");
    expect(streamedText).toContain("无法继续调用工具");
    expect(streamedText).toContain("data: [DONE]");
  });

  it("does not treat model stop-token fragments as visible final answer content", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"<｜DSML｜tool_calls><｜DSML｜invoke name=\\"query_analytics\\">"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"</｜DSML｜invoke></｜DSML｜tool_calls>"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"s>"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "覆盖率低于 70% 的模块有哪些？" }],
      model: "deepseek-v4-flash",
      context: "# Main agent tool result\nTool: query_testing_coverage_project_status\nRows: 4648",
      response,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");

    expect(streamedText).not.toContain("s>");
    expect(streamedText).toContain("无法继续调用工具");
    expect(streamedText).toContain("data: [DONE]");
  });

  it("emits fallback when the final answer stream only contains a stop-token fragment after tool context", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"s>"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "覆盖率低于 70% 的模块有哪些？" }],
      model: "deepseek-v4-flash",
      context: "# Main agent tool result\nTool: query_testing_coverage_project_status\nRows: 4648",
      response,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");

    expect(streamedText).not.toContain("s>");
    expect(streamedText).toContain("无法继续调用工具");
    expect(streamedText).toContain("data: [DONE]");
  });

  it("emits fallback when a model stop token is split across streamed deltas after tool context", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"</"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"s>"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "最近一周新增缺陷集中在哪些 ECU？" }],
      model: "deepseek-v4-flash",
      context: [
        "# Main agent tool result",
        "Tool: query_defect_high_frequency_analysis",
        "Groups: 15 returned of 39 (truncated)",
        "Aggregate rows:",
        "1. IDCEVO-25: defect_count 582",
      ].join("\n"),
      response,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");

    expect(streamedText).not.toContain("</");
    expect(streamedText).not.toContain("s>");
    expect(streamedText).toContain("最终模型没有生成可见回答");
    expect(streamedText).toContain("IDCEVO-25: defect_count 582");
    expect(streamedText).toContain("data: [DONE]");
  });

  it("emits fallback when final answer stream is empty after tool context", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "覆盖率低于 70% 的模块有哪些？" }],
      model: "deepseek-v4-flash",
      context: [
        "# Main agent tool result",
        "Tool: query_testing_coverage_project_status",
        "Rows: 4648",
        "Use these Testing Coverage project-status rows as factual dashboard data.",
        "# Main agent tool result",
        "Tool: query_analytics",
        "Groups: 12 returned of 398 (truncated)",
        "Aggregate rows:",
        "1. DIPS_TSP_Call_Services: defect_count 854",
      ].join("\n"),
      response,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");

    expect(streamedText).toContain("最终模型没有生成可见回答");
    expect(streamedText).toContain("Rows: 4648");
    expect(streamedText).toContain("DIPS_TSP_Call_Services: defect_count 854");
    expect(streamedText).toContain("data: [DONE]");
  });

  it("includes a deterministic tool-result summary when final generation produces no visible answer", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"s>"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "最近一周新增缺陷集中在哪些 ECU？" }],
      model: "deepseek-v4-flash",
      context: [
        "# Main agent tool result",
        "Tool: query_defect_high_frequency_analysis",
        "Total defects: 895",
        "ECU/module count: 39",
        "Repeat rate: 96%",
        "Top ECU/module frequency rows:",
        "1. IDCEVO-25: 582 (Critical)",
        "2. SAM-HERE: 86 (Critical)",
        "This tool answers ECU/module concentration from octane_defects assigned_ecu and creation_time filters.",
      ].join("\n"),
      response,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");

    expect(streamedText).not.toContain("s>");
    expect(streamedText).toContain("最终模型没有生成可见回答");
    expect(streamedText).toContain("Total defects: 895");
    expect(streamedText).toContain("IDCEVO-25: 582");
    expect(streamedText).toContain("SAM-HERE: 86");
  });

  it("adds a deterministic citation footer before validating a tool-backed answer without citations", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const registry = createOntologyRegistry();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"缺陷数是 12"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);
    const onAnswerValidation = vi.fn();

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "缺陷数是多少？" }],
      model: "deepseek-v4-flash",
      context: "# Main agent tool result\nTool: query_semantic_metrics\nResult: 12",
      response,
      answerValidation: {
        registry,
        evidence: [{ toolCallId: "call-1", tool: "query_semantic_metrics", ontologyVersion: "v1", schemaFingerprint: registry.fingerprint }],
      },
      onAnswerValidation,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");
    expect(streamedText).toContain('"type":"answer-validation"');
    expect(streamedText).toContain('source=\\"call-1\\"');
    expect(streamedText).not.toContain("ANSWER_CITATION_REQUIRED");
    expect(streamedText.indexOf('"type":"answer-validation"')).toBeLessThan(streamedText.indexOf("data: [DONE]"));
    expect(onAnswerValidation).toHaveBeenCalledWith(expect.objectContaining({
      valid: true,
      violations: [],
    }));
  });

  it("emits a causal-claim violation for cited observational analytics output", async () => {
    const encoder = new TextEncoder();
    const response = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const registry = createOntologyRegistry();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"ECU A 导致缺陷数上升 <cite source=\\"call-1\\">evidence</cite>"}}]}\n\n' +
                'data: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);
    const onAnswerValidation = vi.fn();

    await streamCompanyChatCompletion({
      messages: [{ role: "user", content: "缺陷数为什么上升？" }],
      model: "deepseek-v4-flash",
      context: "# Main agent tool result\nTool: query_semantic_metrics\nResult: 12",
      response,
      answerValidation: {
        registry,
        evidence: [{ toolCallId: "call-1", tool: "query_semantic_metrics", ontologyVersion: "v1", schemaFingerprint: registry.fingerprint }],
      },
      onAnswerValidation,
    });

    const streamedText = response.write.mock.calls
      .map(([chunk]) => Buffer.from(chunk).toString("utf8"))
      .join("");
    expect(streamedText).toContain("ANSWER_CAUSAL_CLAIM_UNSUPPORTED");
    expect(onAnswerValidation).toHaveBeenCalledWith(expect.objectContaining({
      valid: false,
      violations: ["ANSWER_CAUSAL_CLAIM_UNSUPPORTED"],
    }));
  });
});

describe("requestCompanyChatCompletion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.DUPSEARCH_CHAT_ACCESS_CODE = "test-access-code";
    process.env.DUPSEARCH_CHAT_RETRY_DELAY_MS = "0";
  });

  it("retries retryable upstream failures before returning a non-streaming completion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error", text: async () => "upstream failed" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "recovered" } }] }),
        text: async () => "",
      });

    vi.stubGlobal("fetch", fetchMock);

    const result = await requestCompanyChatCompletion({
      messages: [{ role: "user", content: "hello" }],
      model: "deepseek-v4-flash",
    });

    expect(result.content).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a call-specific one-attempt resilience budget", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "upstream failed",
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(requestCompanyChatCompletion({
      messages: [{ role: "user", content: "classify this analytics question" }],
      model: "deepseek-v4-flash",
      resilience: { maxAttempts: 1, timeoutMs: 1500, retryDelayMs: 0 },
    })).rejects.toThrow("Chat request failed (500)");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns tool calls from non-streaming company chat responses", async () => {
    const toolCalls = [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "query_dashboard_summary",
          arguments: '{"filters":{"years":2026}}',
        },
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: null, tool_calls: toolCalls } }],
      }),
      text: async () => "",
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await requestCompanyChatCompletion({
      messages: [{ role: "user", content: "How many defects?" }],
      model: "deepseek-v4-flash",
      tools: [
        {
          type: "function",
          function: {
            name: "query_dashboard_summary",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      toolChoice: "auto",
    });

    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual(toolCalls);
    const upstreamBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(upstreamBody.tools).toHaveLength(1);
    expect(upstreamBody.tool_choice).toBe("auto");
  });
});