import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestCompanyChatCompletion, streamCompanyChatCompletion } from "../../../server/companyChat.mjs";

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
    expect(systemPrompt).toContain("Only emit <step>");
  });
});

describe("requestCompanyChatCompletion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.DUPSEARCH_CHAT_ACCESS_CODE = "test-access-code";
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